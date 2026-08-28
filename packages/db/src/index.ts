import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, SqliteDialect, sql } from 'kysely';
import type { Authority, DraftEnvironment, DraftPick, DraftState, Health, ObservationPlayer, Player, Recommendation, SessionMode } from '@fda/contracts';
import { assertExpectedRevision, nextPickForSlot, normalizePlayerName, pickCoordinates } from '@fda/domain';
import { demoPlayers } from '@fda/fixtures';
import { ALGORITHM_VERSION, defaultStrategy, recommendPlayers, type Strategy } from '@fda/recommendation';

type PlayerRow = {
  id: string; canonical_name: string; normalized_name: string; position: Player['position']; team: string | null;
  bye_week: number | null; overall_rank: number; positional_rank: number; adp: number | null; projection: number;
  upside: number; reliability: number; risk: number; tier: number; source: string; updated_at: string; excluded: number;
};
type SessionRow = {
  id: string; name: string; mode: SessionMode; state: string; external_platform: string | null; external_draft_id: string | null;
  league_config_version_id: string; strategy_version_id: string; parent_session_id: string | null; restored_from_session_id: string | null;
  user_slot: number; revision: number; created_at: string; archived_at: string | null;
};
type PickRow = {
  session_id: string; overall_pick: number; player_id: string; drafting_slot: number; authority: Authority;
  locked_manual: number; accepted_revision_id: string; revision: number; selected_at: string;
};
type WorkspaceRow = { singleton: number; active_session_id: string | null; updated_at: string };
type GenericRow = Record<string, unknown>;
type DB = {
  players: PlayerRow; draft_sessions: SessionRow; draft_picks: PickRow; workspace_state: WorkspaceRow;
  pick_revisions: GenericRow; league_config_versions: GenericRow; strategy_versions: GenericRow; recommendation_runs: GenericRow;
  operations: GenericRow; audit_events: GenericRow; command_results: GenericRow; draft_observations: GenericRow; reconciliation_conflicts: GenericRow;
  schema_migrations: GenericRow; application_settings: GenericRow;
};

const migrations = [
  { version: '0001_initial', path: fileURLToPath(new URL('../../../migrations/0001_initial.sql', import.meta.url)) },
  { version: '0002_draft_environment', path: fileURLToPath(new URL('../../../migrations/0002_draft_environment.sql', import.meta.url)) },
];

function now(): string { return new Date().toISOString(); }
function checksum(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }

export type RepositoryOptions = { databasePath: string };

export class DraftRepository {
  readonly sqlite: Database.Database;
  readonly db: Kysely<DB>;

  constructor(options: RepositoryOptions) {
    mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
    this.sqlite = new Database(options.databasePath);
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('synchronous = FULL');
    this.sqlite.pragma('busy_timeout = 5000');
    this.sqlite.pragma('trusted_schema = OFF');
    this.db = new Kysely<DB>({ dialect: new SqliteDialect({ database: this.sqlite }) });
    this.migrate();
    this.seed();
  }

  private migrate() {
    for (const migration of migrations) {
      const source = readFileSync(migration.path, 'utf8');
      this.sqlite.exec(source);
      const found = this.sqlite.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(migration.version) as { checksum: string } | undefined;
      const hash = checksum(source);
      if (found && found.checksum !== hash) throw new Error(`Migration checksum mismatch for ${migration.version}`);
      if (!found) this.sqlite.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)').run(migration.version, hash, now());
    }
  }

  private seed() {
    const count = (this.sqlite.prepare('SELECT COUNT(*) AS count FROM players').get() as { count: number }).count;
    if (count === 0) {
      const insert = this.sqlite.prepare(`INSERT INTO players(
        id, canonical_name, normalized_name, position, team, bye_week, overall_rank, positional_rank, adp,
        projection, upside, reliability, risk, tier, source, updated_at, excluded
      ) VALUES (@id, @name, @normalized, @position, @team, @byeWeek, @overallRank, @positionalRank, @adp,
        @projection, @upside, @reliability, @risk, @tier, @source, @updatedAt, @excluded)`);
      const transaction = this.sqlite.transaction((players: Player[]) => {
        for (const player of players) insert.run({ ...player, normalized: normalizePlayerName(player.name), excluded: player.excluded ? 1 : 0 });
      });
      transaction(demoPlayers());
    }
    const league = this.sqlite.prepare('SELECT id FROM league_config_versions LIMIT 1').get() as { id: string } | undefined;
    if (!league) {
      const createdAt = now();
      const leagueConfig = { teamCount: 10, rounds: 15, roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 }, scoring: 'PPR' };
      const strategy = defaultStrategy;
      this.sqlite.prepare('INSERT INTO league_config_versions VALUES (?, ?, ?, ?, ?, ?)').run('league-default-v1', '10-team PPR', 1, JSON.stringify(leagueConfig), checksum(JSON.stringify(leagueConfig)), createdAt);
      this.sqlite.prepare('INSERT INTO strategy_versions VALUES (?, ?, ?, ?, ?, ?)').run('strategy-balanced-v1', 'Balanced upside', 1, JSON.stringify(strategy), checksum(JSON.stringify(strategy)), createdAt);
    }
    const active = this.sqlite.prepare('SELECT active_session_id FROM workspace_state WHERE singleton = 1').get() as { active_session_id: string | null } | undefined;
    if (!active?.active_session_id) {
      const sessionId = randomUUID();
      const createdAt = now();
      this.sqlite.prepare(`INSERT INTO draft_sessions(
        id,name,mode,state,league_config_version_id,strategy_version_id,user_slot,revision,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)`).run(sessionId, 'Draft companion', 'PRACTICE', 'DRAFT', 'league-default-v1', 'strategy-balanced-v1', 4, 0, createdAt);
      this.sqlite.prepare('INSERT OR REPLACE INTO workspace_state(singleton,active_session_id,updated_at) VALUES (1,?,?)').run(sessionId, createdAt);
    }
  }

  close() { this.db.destroy(); }

  integrity() {
    const integrity = this.sqlite.pragma('quick_check') as Array<{ quick_check: string }>;
    const foreignKeys = this.sqlite.pragma('foreign_key_check') as unknown[];
    return { ok: integrity[0]?.quick_check === 'ok' && foreignKeys.length === 0, integrity, foreignKeys };
  }

  backup(destination: string) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    this.sqlite.pragma('wal_checkpoint(FULL)');
    if (existsSync(destination)) unlinkSync(destination);
    this.sqlite.prepare('VACUUM INTO ?').run(destination);
    const backup = new Database(destination, { readonly: true });
    const check = backup.pragma('quick_check') as Array<{ quick_check: string }>;
    backup.close();
    if (check[0]?.quick_check !== 'ok') throw new Error('Backup integrity check failed');
    return { path: destination, createdAt: now() };
  }

  getActiveSession(): SessionRow {
    const session = this.sqlite.prepare(`SELECT s.* FROM draft_sessions s
      JOIN workspace_state w ON w.active_session_id = s.id WHERE w.singleton = 1`).get() as SessionRow | undefined;
    if (!session) throw new Error('No active session');
    return session;
  }

  getDraftEnvironment(): DraftEnvironment {
    const row = this.sqlite.prepare('SELECT draft_environment FROM application_settings WHERE singleton=1').get() as { draft_environment: DraftEnvironment };
    return row.draft_environment;
  }

  setDraftEnvironment(environment: DraftEnvironment) {
    const updatedAt = now();
    this.sqlite.prepare('UPDATE application_settings SET draft_environment=?, updated_at=? WHERE singleton=1').run(environment, updatedAt);
    return { environment, updatedAt };
  }

  activateObservedSession(input: { externalDraftId?: string; name?: string; teamCount?: number; rounds?: number; userSlot?: number; replace?: boolean }) {
    return this.sqlite.transaction(() => {
      const current = this.getActiveSession();
      const createdAt = now();
      let leagueConfigVersionId = current.league_config_version_id;
      if (input.teamCount && input.rounds) {
        const config = {
          teamCount: input.teamCount, rounds: input.rounds,
          roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BENCH: Math.max(0, input.rounds - 10) },
          scoring: 'PPR', source: 'espn-observed',
        };
        const json = JSON.stringify(config);
        leagueConfigVersionId = `league-espn-${checksum(json).slice(0, 16)}`;
        this.sqlite.prepare('INSERT OR IGNORE INTO league_config_versions VALUES (?, ?, ?, ?, ?, ?)')
          .run(leagueConfigVersionId, `${input.teamCount}-team ESPN observed`, 1, json, checksum(json), createdAt);
      }
      const existing = input.externalDraftId
        ? this.sqlite.prepare("SELECT * FROM draft_sessions WHERE external_platform='espn' AND external_draft_id=? AND state<>'DELETED'").get(input.externalDraftId) as SessionRow | undefined
        : undefined;
      if (current.external_platform === 'espn' && current.external_draft_id && input.externalDraftId && current.external_draft_id !== input.externalDraftId && !input.replace) {
        throw Object.assign(new Error('This session is bound to a different ESPN draft'), { statusCode: 409, code: 'EXTERNAL_DRAFT_MISMATCH' });
      }
      if (current.external_platform === 'espn' && (!current.external_draft_id || !input.externalDraftId || current.external_draft_id === input.externalDraftId)) {
        this.sqlite.prepare(`UPDATE draft_sessions SET external_platform='espn', external_draft_id=COALESCE(external_draft_id, ?), league_config_version_id=?, user_slot=?, state='ACTIVE' WHERE id=?`)
          .run(input.externalDraftId ?? null, leagueConfigVersionId, input.userSlot ?? current.user_slot, current.id);
        return { sessionId: current.id, created: false };
      }
      if (existing) {
        this.sqlite.prepare("UPDATE draft_sessions SET state='ARCHIVED', archived_at=? WHERE id=?").run(createdAt, current.id);
        this.sqlite.prepare("UPDATE draft_sessions SET state='ACTIVE', archived_at=NULL, league_config_version_id=?, user_slot=? WHERE id=?")
          .run(leagueConfigVersionId, input.userSlot ?? existing.user_slot, existing.id);
        this.sqlite.prepare('UPDATE workspace_state SET active_session_id=?, updated_at=? WHERE singleton=1').run(existing.id, createdAt);
        return { sessionId: existing.id, created: false };
      }
      const sessionId = randomUUID();
      this.sqlite.prepare("UPDATE draft_sessions SET state='ARCHIVED', archived_at=? WHERE id=?").run(createdAt, current.id);
      this.sqlite.prepare(`INSERT INTO draft_sessions(
        id,name,mode,state,external_platform,external_draft_id,league_config_version_id,strategy_version_id,parent_session_id,user_slot,revision,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        sessionId, input.name ?? 'ESPN live draft', 'REAL', 'ACTIVE', 'espn', input.externalDraftId ?? null,
        leagueConfigVersionId, current.strategy_version_id, current.id, input.userSlot ?? current.user_slot, 0, createdAt,
      );
      this.sqlite.prepare('UPDATE workspace_state SET active_session_id=?, updated_at=? WHERE singleton=1').run(sessionId, createdAt);
      this.sqlite.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?,?)').run(
        randomUUID(), 'draft_session', sessionId, 'ESPN_DRAFT_BOUND', 'browser-bind',
        JSON.stringify({ priorSessionId: current.id }), JSON.stringify({ externalDraftId: input.externalDraftId ?? null }),
        'Explicitly followed a detected ESPN draft page', createdAt,
      );
      return { sessionId, created: true };
    })();
  }

  listPlayers(): Player[] {
    const rows = this.sqlite.prepare('SELECT * FROM players ORDER BY overall_rank, id').all() as PlayerRow[];
    return rows.map((row) => this.rowToPlayer(row));
  }

  listPicks(sessionId: string, teamCount = 10): DraftPick[] {
    const rows = this.sqlite.prepare(`SELECT p.*, pl.canonical_name, pl.position, pl.team FROM draft_picks p
      JOIN players pl ON pl.id = p.player_id WHERE p.session_id = ? ORDER BY p.overall_pick`).all(sessionId) as Array<PickRow & { canonical_name: string; position: Player['position']; team: string | null }>;
    return rows.map((row) => ({
      overallPick: row.overall_pick, ...pickCoordinates(row.overall_pick, teamCount), playerId: row.player_id,
      playerName: row.canonical_name, position: row.position, team: row.team, authority: row.authority,
      lockedManual: row.locked_manual === 1, selectedAt: row.selected_at,
    }));
  }

  private configFor(session: SessionRow): { teamCount: number; rounds: number } {
    const row = this.sqlite.prepare('SELECT config_json FROM league_config_versions WHERE id = ?').get(session.league_config_version_id) as { config_json: string };
    return JSON.parse(row.config_json) as { teamCount: number; rounds: number };
  }

  private strategyFor(session: SessionRow): Strategy {
    const row = this.sqlite.prepare('SELECT config_json FROM strategy_versions WHERE id = ?').get(session.strategy_version_id) as { config_json: string };
    return JSON.parse(row.config_json) as Strategy;
  }

  getState(health: Health): DraftState {
    const session = this.getActiveSession();
    const config = this.configFor(session);
    const players = this.listPlayers().filter((player) => !player.excluded);
    const picks = this.listPicks(session.id, config.teamCount);
    const currentOverallPick = Math.min(config.teamCount * config.rounds, (picks.at(-1)?.overallPick ?? 0) + 1);
    const nextUserPick = nextPickForSlot(currentOverallPick - 1, config.teamCount, config.rounds, session.user_slot);
    const recommendations = recommendPlayers({ players, picks, userSlot: session.user_slot, currentOverallPick, nextUserPick, strategy: this.strategyFor(session) });
    const drafted = new Set(picks.map((pick) => pick.playerId));
    const conflicts = this.sqlite.prepare("SELECT id, overall_pick, candidate_json FROM reconciliation_conflicts WHERE session_id = ? AND status = 'OPEN'").all(session.id) as Array<{ id: string; overall_pick: number; candidate_json: string }>;
    const operation = this.sqlite.prepare("SELECT id, operation_type FROM operations WHERE state = 'COMPLETED' ORDER BY created_at DESC LIMIT 1").get() as { id: string; operation_type: string } | undefined;
    return {
      environment: this.getDraftEnvironment(),
      session: {
        id: session.id, name: session.name, mode: session.mode, state: session.state, revision: session.revision,
        userSlot: session.user_slot, teamCount: config.teamCount, rounds: config.rounds, currentOverallPick,
        currentRound: Math.ceil(currentOverallPick / config.teamCount), nextUserPick,
        isUserTurn: nextUserPick === currentOverallPick,
      },
      picks,
      players: players.map((player) => ({ ...player, drafted: drafted.has(player.id) })),
      recommendations,
      roster: picks.filter((pick) => pick.draftingSlot === session.user_slot),
      conflicts: conflicts.map((row) => ({ id: row.id, overallPick: row.overall_pick, summary: JSON.parse(row.candidate_json).summary ?? 'Observation conflict' })),
      lastOperation: operation ? { id: operation.id, type: operation.operation_type, undoable: operation.operation_type === 'RESET_SESSION' } : null,
      health,
    };
  }

  private idempotent(commandId: string): unknown | null {
    const prior = this.sqlite.prepare('SELECT result_json FROM command_results WHERE command_id = ?').get(commandId) as { result_json: string } | undefined;
    return prior ? JSON.parse(prior.result_json) : null;
  }

  applyPick(input: { commandId: string; expectedRevision: number; playerId: string; overallPick?: number; authority: Authority; reason?: string }) {
    const prior = this.idempotent(input.commandId);
    if (prior) return prior;
    const transaction = this.sqlite.transaction(() => {
      const session = this.getActiveSession();
      assertExpectedRevision(input.expectedRevision, session.revision);
      const config = this.configFor(session);
      const overallPick = input.overallPick ?? ((this.sqlite.prepare('SELECT MAX(overall_pick) AS pick FROM draft_picks WHERE session_id = ?').get(session.id) as { pick: number | null }).pick ?? 0) + 1;
      if (overallPick > config.teamCount * config.rounds) throw Object.assign(new Error('Draft is complete'), { statusCode: 409, code: 'DRAFT_COMPLETE' });
      const player = this.sqlite.prepare('SELECT id FROM players WHERE id = ?').get(input.playerId);
      if (!player) throw Object.assign(new Error('Player not found'), { statusCode: 404, code: 'PLAYER_NOT_FOUND' });
      const duplicate = this.sqlite.prepare('SELECT overall_pick FROM draft_picks WHERE session_id = ? AND player_id = ? AND overall_pick <> ?').get(session.id, input.playerId, overallPick) as { overall_pick: number } | undefined;
      if (duplicate) throw Object.assign(new Error(`Player already drafted at pick ${duplicate.overall_pick}`), { statusCode: 409, code: 'PLAYER_ALREADY_DRAFTED' });
      const existing = this.sqlite.prepare('SELECT * FROM draft_picks WHERE session_id = ? AND overall_pick = ?').get(session.id, overallPick) as PickRow | undefined;
      if (existing?.player_id === input.playerId) {
        const result = { sessionId: session.id, revision: session.revision, overallPick, playerId: input.playerId, unchanged: true };
        this.sqlite.prepare('INSERT INTO command_results VALUES (?,?,?,?)').run(input.commandId, session.id, JSON.stringify(result), now());
        return result;
      }
      const revisionId = randomUUID();
      const createdAt = now();
      const authority = input.authority;
      this.sqlite.prepare(`INSERT INTO pick_revisions(id,session_id,overall_pick,player_id,drafting_slot,authority,action,supersedes_revision_id,reason,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(revisionId, session.id, overallPick, input.playerId, pickCoordinates(overallPick, config.teamCount).draftingSlot,
          authority, existing ? 'CORRECT' : 'ADD', existing?.accepted_revision_id ?? null, input.reason ?? null, createdAt);
      if (existing) {
        if (existing.locked_manual && authority !== 'manual') {
          this.sqlite.prepare('INSERT INTO reconciliation_conflicts VALUES (?,?,?,?,?,?)').run(randomUUID(), session.id, overallPick, JSON.stringify({ summary: 'Automated evidence conflicts with a manual lock', playerId: input.playerId }), 'OPEN', createdAt);
          return { sessionId: session.id, revision: session.revision, conflict: true };
        }
        this.sqlite.prepare(`UPDATE draft_picks SET player_id=?, drafting_slot=?, authority=?, locked_manual=?, accepted_revision_id=?, revision=revision+1, selected_at=?
          WHERE session_id=? AND overall_pick=?`).run(input.playerId, pickCoordinates(overallPick, config.teamCount).draftingSlot, authority, authority === 'manual' ? 1 : 0, revisionId, createdAt, session.id, overallPick);
      } else {
        this.sqlite.prepare('INSERT INTO draft_picks VALUES (?,?,?,?,?,?,?,?,?)').run(session.id, overallPick, input.playerId,
          pickCoordinates(overallPick, config.teamCount).draftingSlot, authority, authority === 'manual' ? 1 : 0, revisionId, 1, createdAt);
      }
      const nextRevision = session.revision + 1;
      this.sqlite.prepare("UPDATE draft_sessions SET state='ACTIVE', revision=? WHERE id=?").run(nextRevision, session.id);
      const result = { sessionId: session.id, revision: nextRevision, overallPick, playerId: input.playerId };
      this.sqlite.prepare('INSERT INTO command_results VALUES (?,?,?,?)').run(input.commandId, session.id, JSON.stringify(result), createdAt);
      this.sqlite.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), 'draft_session', session.id, existing ? 'PICK_CORRECTED' : 'PICK_ADDED', input.commandId,
        existing ? JSON.stringify(existing) : null, JSON.stringify(result), input.reason ?? null, createdAt);
      return result;
    });
    return transaction();
  }

  resetSession(input: { commandId: string; expectedRevision: number; confirmation: { sessionId: string; mode: SessionMode; pickCount: number } }) {
    const prior = this.idempotent(input.commandId);
    if (prior) return prior;
    return this.sqlite.transaction(() => {
      const session = this.getActiveSession();
      assertExpectedRevision(input.expectedRevision, session.revision);
      const pickCount = (this.sqlite.prepare('SELECT COUNT(*) AS count FROM draft_picks WHERE session_id = ?').get(session.id) as { count: number }).count;
      if (input.confirmation.sessionId !== session.id || input.confirmation.mode !== session.mode || input.confirmation.pickCount !== pickCount) {
        throw Object.assign(new Error('Reset confirmation no longer matches current state'), { statusCode: 409, code: 'CONFIRMATION_MISMATCH' });
      }
      const childId = randomUUID();
      const operationId = randomUUID();
      const createdAt = now();
      this.sqlite.prepare("UPDATE draft_sessions SET state='RESET_ARCHIVED', archived_at=? WHERE id=?").run(createdAt, session.id);
      this.sqlite.prepare(`INSERT INTO draft_sessions(id,name,mode,state,league_config_version_id,strategy_version_id,parent_session_id,user_slot,revision,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(childId, `${session.name} — reset`, session.mode, 'DRAFT', session.league_config_version_id, session.strategy_version_id, session.id, session.user_slot, 0, createdAt);
      this.sqlite.prepare('UPDATE workspace_state SET active_session_id=?, updated_at=? WHERE singleton=1').run(childId, createdAt);
      const result = { operationId, parentId: session.id, childId, revision: 0 };
      this.sqlite.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?)').run(operationId, 'RESET_SESSION', 'COMPLETED', session.id, JSON.stringify(result), null, createdAt);
      this.sqlite.prepare('INSERT INTO command_results VALUES (?,?,?,?)').run(input.commandId, session.id, JSON.stringify(result), createdAt);
      return result;
    })();
  }

  undoOperation(operationId: string) {
    return this.sqlite.transaction(() => {
      const operation = this.sqlite.prepare('SELECT * FROM operations WHERE id = ?').get(operationId) as { id: string; operation_type: string; state: string; result_json: string } | undefined;
      if (!operation || operation.operation_type !== 'RESET_SESSION' || operation.state !== 'COMPLETED') throw Object.assign(new Error('Operation is not undoable'), { statusCode: 409, code: 'NOT_UNDOABLE' });
      const result = JSON.parse(operation.result_json) as { parentId: string; childId: string };
      const createdAt = now();
      this.sqlite.prepare("UPDATE draft_sessions SET state='ARCHIVED', archived_at=? WHERE id=?").run(createdAt, result.childId);
      this.sqlite.prepare("UPDATE draft_sessions SET state='ACTIVE', archived_at=NULL, revision=revision+1 WHERE id=?").run(result.parentId);
      this.sqlite.prepare('UPDATE workspace_state SET active_session_id=?, updated_at=? WHERE singleton=1').run(result.parentId, createdAt);
      this.sqlite.prepare("UPDATE operations SET state='UNDONE' WHERE id=?").run(operationId);
      return { sessionId: result.parentId, undoneOperationId: operationId };
    })();
  }

  recordObservation(input: { sessionId: string; mechanism: string; kind: string; adapterSchemaVersion: string; externalDraftId?: string; dedupeKey: string; payload: unknown; parseStatus: string }) {
    const observedAt = now();
    const seq = (this.sqlite.prepare('SELECT COALESCE(MAX(monotonic_seq),0)+1 AS seq FROM draft_observations WHERE session_id=?').get(input.sessionId) as { seq: number }).seq;
    const result = this.sqlite.prepare(`INSERT OR IGNORE INTO draft_observations(
      id,session_id,mechanism,kind,adapter_schema_version,external_draft_id,observed_at,monotonic_seq,dedupe_key,payload_inline,parse_status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), input.sessionId, input.mechanism, input.kind, input.adapterSchemaVersion, input.externalDraftId ?? null, observedAt, seq, input.dedupeKey, JSON.stringify(input.payload), input.parseStatus);
    return { inserted: result.changes === 1, observedAt };
  }

  resolvePlayer(input: { source: string; externalId?: string; name?: string; scopeKey?: string }): Player | null {
    if (input.externalId) {
      const mapped = this.sqlite.prepare(`SELECT p.* FROM external_identities e JOIN players p ON p.id=e.player_id
        WHERE e.source_id=? AND e.namespace='player' AND e.external_id=? AND e.scope_key=?`).get(input.source, input.externalId, input.scopeKey ?? 'season:2026') as PlayerRow | undefined;
      if (mapped) return this.rowToPlayer(mapped);
    }
    if (!input.name) return null;
    const normalized = normalizePlayerName(input.name);
    const matches = this.sqlite.prepare('SELECT * FROM players WHERE normalized_name=?').all(normalized) as PlayerRow[];
    if (matches.length !== 1) return null;
    if (input.externalId) {
      this.sqlite.prepare(`INSERT OR IGNORE INTO external_identities(source_id,namespace,external_id,scope_key,player_id,created_at)
        VALUES (?,'player',?,?,?,?)`).run(input.source, input.externalId, input.scopeKey ?? 'season:2026', matches[0]!.id, now());
    }
    return this.rowToPlayer(matches[0]!);
  }

  upsertObservedPlayers(players: ObservationPlayer[], source = 'espn') {
    if (!players.length) return { upserted: 0, activatedCatalog: false };
    return this.sqlite.transaction(() => {
      const createdAt = now();
      let upserted = 0;
      for (const observed of players) {
        const mapped = this.sqlite.prepare(`SELECT p.* FROM external_identities e JOIN players p ON p.id=e.player_id
          WHERE e.source_id=? AND e.namespace='player' AND e.external_id=? AND e.scope_key='season:2026'`).get(source, observed.externalPlayerId) as PlayerRow | undefined;
        const named = mapped ?? this.sqlite.prepare('SELECT * FROM players WHERE normalized_name=? LIMIT 1').get(normalizePlayerName(observed.playerName)) as PlayerRow | undefined;
        const rank = Math.max(1, Math.round(observed.overallRank ?? observed.adp ?? named?.overall_rank ?? 999));
        const positionalRank = Math.max(1, Math.round(observed.positionalRank ?? named?.positional_rank ?? rank));
        const reliability = clamp(94 - (rank - 1) * 0.28, 45, 94);
        const upside = clamp(98 - (positionalRank - 1) * 1.15, 48, 98);
        const risk = clamp(106 - reliability, 12, 61);
        const playerId = named?.id ?? `espn-${observed.externalPlayerId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}`;
        if (named) {
          if (named.source.startsWith('ESPN passive')) {
            this.sqlite.prepare(`UPDATE players SET canonical_name=?, normalized_name=?, position=?, team=?, overall_rank=?, positional_rank=?,
              adp=?, projection=?, upside=?, reliability=?, risk=?, tier=?, source=?, updated_at=?, excluded=0 WHERE id=?`).run(
              observed.playerName, normalizePlayerName(observed.playerName), observed.position, observed.team, rank, positionalRank,
              observed.adp, observed.projection ?? 0, upside, reliability, risk, Math.max(1, Math.ceil(rank / 24)),
              'ESPN passive catalog · provisional recommendation calibration', createdAt, playerId,
            );
          }
        } else {
          this.sqlite.prepare(`INSERT OR IGNORE INTO players(
            id,canonical_name,normalized_name,position,team,bye_week,overall_rank,positional_rank,adp,projection,upside,reliability,risk,tier,source,updated_at,excluded
          ) VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,0)`).run(
            playerId, observed.playerName, normalizePlayerName(observed.playerName), observed.position, observed.team, rank, positionalRank,
            observed.adp, observed.projection ?? 0, upside, reliability, risk, Math.max(1, Math.ceil(rank / 24)),
            'ESPN passive catalog · provisional recommendation calibration', createdAt,
          );
        }
        this.sqlite.prepare(`INSERT OR IGNORE INTO external_identities(source_id,namespace,external_id,scope_key,player_id,created_at)
          VALUES (?,'player',?,'season:2026',?,?)`).run(source, observed.externalPlayerId, playerId, createdAt);
        upserted += 1;
      }
      const catalogCount = (this.sqlite.prepare("SELECT COUNT(*) AS count FROM external_identities WHERE source_id=? AND namespace='player' AND scope_key='season:2026'").get(source) as { count: number }).count;
      const activatedCatalog = catalogCount >= 30;
      if (activatedCatalog) this.sqlite.prepare("UPDATE players SET excluded=1 WHERE source LIKE 'Bundled demo fixture%'").run();
      return { upserted, activatedCatalog };
    })();
  }

  private rowToPlayer(row: PlayerRow): Player {
    return {
      id: row.id, name: row.canonical_name, position: row.position, team: row.team, byeWeek: row.bye_week,
      overallRank: row.overall_rank, positionalRank: row.positional_rank, adp: row.adp, projection: row.projection,
      upside: row.upside, reliability: row.reliability, risk: row.risk, tier: row.tier, source: row.source,
      updatedAt: row.updated_at, excluded: row.excluded === 1,
    };
  }

  persistRecommendations(sessionId: string, revision: number, recommendations: Recommendation[], cause: string, durationMs: number) {
    const session = this.sqlite.prepare('SELECT strategy_version_id FROM draft_sessions WHERE id=?').get(sessionId) as { strategy_version_id: string };
    this.sqlite.prepare(`INSERT OR REPLACE INTO recommendation_runs(id,session_id,session_revision,algorithm_version,strategy_version_id,cause,results_json,duration_ms,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(randomUUID(), sessionId, revision, ALGORITHM_VERSION, session.strategy_version_id, cause, JSON.stringify(recommendations), durationMs, now());
  }
}

export function defaultDataDirectory(): string {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME is unavailable');
  return process.env.FDA_DATA_DIR ?? join(home, 'Library', 'Application Support', 'Fantasy Draft Assistant');
}
