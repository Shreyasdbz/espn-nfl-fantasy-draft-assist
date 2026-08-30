import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, SqliteDialect, sql } from 'kysely';
import type { Authority, DraftEnvironment, DraftPick, DraftState, Health, ObservationPlayer, Player, PlayerIntelligence, PlayerResearch, Position, Recommendation, SessionMode } from '@fda/contracts';
import { assertExpectedRevision, nextPickForSlot, normalizePlayerName, pickCoordinates } from '@fda/domain';
import { demoPlayers } from '@fda/fixtures';
import { ALGORITHM_VERSION, analyzeRecommendationContext, defaultPositionLimits, defaultStrategy, recommendPlayers, type PositionLimits, type RosterRules, type Strategy } from '@fda/recommendation';

type PlayerRow = {
  id: string; canonical_name: string; normalized_name: string; position: Player['position']; team: string | null;
  bye_week: number | null; overall_rank: number; positional_rank: number; adp: number | null; projection: number;
  upside: number; reliability: number; risk: number; tier: number; source: string; updated_at: string; excluded: number;
};
type PlayerResearchRow = {
  research_espn_rank: number | null; research_recommended_round: number | null; research_planned_pick: number | null;
  research_phase: string | null; research_archetype: string | null; research_opportunity: number | null;
  research_role_clarity: number | null; research_vision_score: number | null; research_model_signal: string | null;
  research_user_tag: string | null; research_injury_news: string | null; research_why_fits: string | null;
  research_failure_case: string | null; research_alternatives: string | null; research_pairing_construction: string | null;
  research_earliest_pick: number | null; research_target_pick: number | null; research_latest_pick: number | null;
  research_espn_source: string | null; research_adp_source: string | null; research_analysis_source: string | null;
  research_imported_draft_status: string | null; research_researched_at: string | null;
};
type PlayerIntelligenceRow = {
  intelligence_profile_version: string | null; intelligence_sample_season: number | null; intelligence_games: number | null;
  intelligence_age: number | null; intelligence_roster_status: string | null; intelligence_prior_team: string | null;
  intelligence_current_team: string | null; intelligence_fantasy_points_ppr: number | null; intelligence_fantasy_ppg_ppr: number | null;
  intelligence_late_season_ppg_ppr: number | null; intelligence_carries: number | null; intelligence_targets: number | null;
  intelligence_receptions: number | null; intelligence_scrimmage_yards: number | null; intelligence_total_touchdowns: number | null;
  intelligence_opportunities_per_game: number | null; intelligence_target_share: number | null; intelligence_air_yards_share: number | null;
  intelligence_trend_score: number | null; intelligence_floor_score: number | null; intelligence_ceiling_score: number | null;
  intelligence_role_summary: string | null; intelligence_floor_case: string | null; intelligence_ceiling_case: string | null;
  intelligence_risk_note: string | null; intelligence_evidence_json: string | null; intelligence_source_count: number | null;
  intelligence_data_quality: string | null; intelligence_researched_at: string | null;
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
  schema_migrations: GenericRow; application_settings: GenericRow; research_imports: GenericRow; player_research: GenericRow;
  player_intelligence: GenericRow;
};

const migrations = [
  { version: '0001_initial', path: fileURLToPath(new URL('../../../migrations/0001_initial.sql', import.meta.url)) },
  { version: '0002_draft_environment', path: fileURLToPath(new URL('../../../migrations/0002_draft_environment.sql', import.meta.url)) },
  { version: '0003_research_catalog', path: fileURLToPath(new URL('../../../migrations/0003_research_catalog.sql', import.meta.url)) },
  { version: '0004_player_intelligence', path: fileURLToPath(new URL('../../../migrations/0004_player_intelligence.sql', import.meta.url)) },
];

function now(): string { return new Date().toISOString(); }
function checksum(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }

export type RepositoryOptions = { databasePath: string };

export type ResearchPlayerInput = {
  name: string; position: Position; team: string | null; byeWeek: number | null; espnRank: number; modelRank: number;
  positionalRank: number; adp: number | null; recommendedRound: number | null; plannedPick: number | null;
  phase: string; archetype: string; reliability: number; ceiling: number; opportunity: number; roleClarity: number;
  risk: number; visionScore: number; modelSignal: string; userTag: string; injuryNews: string; whyFits: string;
  failureCase: string; alternatives: string; pairingConstruction: string; earliestPick: number | null;
  targetPick: number | null; latestPick: number | null; espnSource: string; adpSource: string;
  analysisSource: string; importedDraftStatus: string; updatedAt: string;
};

export type ResearchDataset = {
  checksum: string; sourceFilename: string; sourcePath: string; leagueName: string; teamName: string;
  teamCount: number; rounds: number; userSlot: number; scoring: string; roster: Record<string, number>;
  thesis: string; updatedAt: string; players: ResearchPlayerInput[];
};

export type PlayerIntelligenceInput = {
  name: string; nflverseId: string; profileVersion: string; sampleSeason: number; games: number; age: number | null;
  rosterStatus: string | null; priorTeam: string | null; currentTeam: string | null; fantasyPointsPpr: number | null;
  fantasyPpgPpr: number | null; lateSeasonPpgPpr: number | null; carries: number | null; targets: number | null;
  receptions: number | null; scrimmageYards: number | null; totalTouchdowns: number | null;
  opportunitiesPerGame: number | null; targetShare: number | null; airYardsShare: number | null; trendScore: number | null;
  floorScore: number; ceilingScore: number; roleSummary: string; floorCase: string; ceilingCase: string; riskNote: string;
  evidence: Array<{ source: string; kind: string; claim: string }>; sourceCount: number;
  dataQuality: 'strong' | 'partial' | 'context-only'; researchedAt: string;
};

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
      const leagueConfig = { teamCount: 10, rounds: 15, roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 }, positionLimits: defaultPositionLimits, scoring: 'PPR' };
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

  activateObservedSession(input: { externalDraftId?: string; name?: string; teamCount?: number; rounds?: number; userSlot?: number; roster?: Partial<RosterRules>; positionLimits?: Partial<PositionLimits>; replace?: boolean }) {
    return this.sqlite.transaction(() => {
      const current = this.getActiveSession();
      const createdAt = now();
      let leagueConfigVersionId = current.league_config_version_id;
      if (input.teamCount && input.rounds) {
        const priorConfigRow = this.sqlite.prepare('SELECT config_json FROM league_config_versions WHERE id=?').get(current.league_config_version_id) as { config_json: string } | undefined;
        const priorConfig = priorConfigRow ? JSON.parse(priorConfigRow.config_json) as { teamCount?: number; rounds?: number; roster?: Partial<RosterRules>; positionLimits?: Partial<PositionLimits>; scoring?: string; source?: string } : undefined;
        const canPreserve = priorConfig?.teamCount === input.teamCount && priorConfig.rounds === input.rounds;
        const config = {
          teamCount: input.teamCount, rounds: input.rounds,
          roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BENCH: Math.max(0, input.rounds - 10), ...(canPreserve ? priorConfig?.roster : {}), ...input.roster },
          positionLimits: { ...defaultPositionLimits, ...(canPreserve ? priorConfig?.positionLimits : {}), ...input.positionLimits },
          scoring: canPreserve ? priorConfig?.scoring ?? 'Full PPR; 4-point passing TDs' : 'Full PPR; 4-point passing TDs',
          source: input.roster || input.positionLimits ? 'espn-observed-exact' : canPreserve ? priorConfig?.source ?? 'espn-observed' : 'espn-observed',
        };
        const json = JSON.stringify(config);
        const configChecksum = checksum(json);
        const priorVersion = this.sqlite.prepare('SELECT id FROM league_config_versions WHERE checksum=? LIMIT 1').get(configChecksum) as { id: string } | undefined;
        if (priorVersion) leagueConfigVersionId = priorVersion.id;
        else {
          const configName = `${input.teamCount}-team ESPN observed`;
          const nextVersion = (this.sqlite.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM league_config_versions WHERE name=?').get(configName) as { version: number }).version;
          leagueConfigVersionId = `league-espn-${configChecksum.slice(0, 16)}`;
          this.sqlite.prepare('INSERT INTO league_config_versions VALUES (?, ?, ?, ?, ?, ?)')
            .run(leagueConfigVersionId, configName, nextVersion, json, configChecksum, createdAt);
        }
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

  importResearchDataset(dataset: ResearchDataset) {
    return this.sqlite.transaction(() => {
      const prior = this.sqlite.prepare('SELECT id, imported_at, row_count FROM research_imports WHERE checksum=?').get(dataset.checksum) as { id: string; imported_at: string; row_count: number } | undefined;
      if (prior) return { importId: prior.id, importedAt: prior.imported_at, rowCount: prior.row_count, inserted: 0, updated: 0, unchanged: true, configuredSession: false };

      const importedAt = now();
      const importId = `research-${dataset.checksum.slice(0, 24)}`;
      const metadata = {
        leagueName: dataset.leagueName, teamName: dataset.teamName, teamCount: dataset.teamCount,
        rounds: dataset.rounds, userSlot: dataset.userSlot, scoring: dataset.scoring,
        roster: dataset.roster, thesis: dataset.thesis, updatedAt: dataset.updatedAt,
      };
      this.sqlite.prepare(`INSERT INTO research_imports(id,checksum,source_filename,source_path,imported_at,row_count,metadata_json)
        VALUES (?,?,?,?,?,?,?)`).run(importId, dataset.checksum, dataset.sourceFilename, dataset.sourcePath, importedAt, dataset.players.length, JSON.stringify(metadata));

      this.sqlite.prepare("UPDATE players SET excluded=1 WHERE source LIKE 'Bundled demo fixture%' OR source LIKE 'Research workbook:%'").run();
      const insertPlayer = this.sqlite.prepare(`INSERT INTO players(
        id,canonical_name,normalized_name,position,team,bye_week,overall_rank,positional_rank,adp,projection,
        upside,reliability,risk,tier,source,updated_at,excluded
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`);
      const updatePlayer = this.sqlite.prepare(`UPDATE players SET canonical_name=?,normalized_name=?,position=?,team=?,bye_week=?,
        overall_rank=?,positional_rank=?,adp=?,projection=?,upside=?,reliability=?,risk=?,tier=?,source=?,updated_at=?,excluded=0 WHERE id=?`);
      const upsertResearch = this.sqlite.prepare(`INSERT INTO player_research(
        player_id,import_id,espn_rank,recommended_round,planned_pick,phase,archetype,opportunity,role_clarity,vision_score,
        model_signal,user_tag,injury_news,why_fits,failure_case,alternatives,pairing_construction,earliest_pick,target_pick,
        latest_pick,espn_source,adp_source,analysis_source,imported_draft_status,researched_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(player_id) DO UPDATE SET
        import_id=excluded.import_id,espn_rank=excluded.espn_rank,recommended_round=excluded.recommended_round,
        planned_pick=excluded.planned_pick,phase=excluded.phase,archetype=excluded.archetype,opportunity=excluded.opportunity,
        role_clarity=excluded.role_clarity,vision_score=excluded.vision_score,model_signal=excluded.model_signal,
        user_tag=excluded.user_tag,injury_news=excluded.injury_news,why_fits=excluded.why_fits,failure_case=excluded.failure_case,
        alternatives=excluded.alternatives,pairing_construction=excluded.pairing_construction,earliest_pick=excluded.earliest_pick,
        target_pick=excluded.target_pick,latest_pick=excluded.latest_pick,espn_source=excluded.espn_source,
        adp_source=excluded.adp_source,analysis_source=excluded.analysis_source,
        imported_draft_status=excluded.imported_draft_status,researched_at=excluded.researched_at`);

      let inserted = 0;
      let updated = 0;
      for (const player of dataset.players) {
        const normalized = normalizePlayerName(player.name);
        const existing = this.sqlite.prepare('SELECT id FROM players WHERE normalized_name=? LIMIT 1').get(normalized) as { id: string } | undefined;
        const playerId = existing?.id ?? `research-${checksum(normalized).slice(0, 20)}`;
        const tier = ({ Anchor: 1, Build: 2, Upside: 3, Lottery: 4 } as Record<string, number>)[player.phase] ?? Math.max(1, Math.ceil(player.modelRank / 24));
        const source = `Research workbook: ${dataset.sourceFilename}`;
        const values = [
          player.name, normalized, player.position, player.team, player.byeWeek, player.modelRank, player.positionalRank,
          player.adp, player.visionScore, clamp(player.ceiling * 10, 0, 100), clamp(player.reliability * 10, 0, 100),
          clamp(player.risk * 10, 0, 100), tier, source, player.updatedAt,
        ] as const;
        if (existing) {
          updatePlayer.run(...values, playerId);
          updated += 1;
        } else {
          insertPlayer.run(playerId, ...values);
          inserted += 1;
        }
        upsertResearch.run(
          playerId, importId, player.espnRank, player.recommendedRound, player.plannedPick, player.phase, player.archetype,
          player.opportunity, player.roleClarity, player.visionScore, player.modelSignal, player.userTag, player.injuryNews,
          player.whyFits, player.failureCase, player.alternatives, player.pairingConstruction, player.earliestPick,
          player.targetPick, player.latestPick, player.espnSource, player.adpSource, player.analysisSource,
          player.importedDraftStatus, player.updatedAt,
        );
      }

      const config = {
        teamCount: dataset.teamCount, rounds: dataset.rounds, roster: dataset.roster, scoring: dataset.scoring,
        positionLimits: defaultPositionLimits,
        source: 'research-workbook', leagueName: dataset.leagueName, teamName: dataset.teamName,
      };
      const configJson = JSON.stringify(config);
      const leagueConfigVersionId = `league-research-${checksum(configJson).slice(0, 16)}`;
      this.sqlite.prepare('INSERT OR IGNORE INTO league_config_versions VALUES (?, ?, ?, ?, ?, ?)').run(
        leagueConfigVersionId, `${dataset.teamCount}-team ${dataset.scoring}`, 1, configJson, checksum(configJson), importedAt,
      );
      const active = this.getActiveSession();
      const pickCount = (this.sqlite.prepare('SELECT COUNT(*) AS count FROM draft_picks WHERE session_id=?').get(active.id) as { count: number }).count;
      const configuredSession = pickCount === 0 && active.external_platform === null;
      if (configuredSession) {
        this.sqlite.prepare(`UPDATE draft_sessions SET name=?,mode='PRACTICE',league_config_version_id=?,user_slot=? WHERE id=?`).run(
          `${dataset.teamName} practice companion`, leagueConfigVersionId, dataset.userSlot, active.id,
        );
      }
      this.sqlite.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?,?)').run(
        randomUUID(), 'research_import', importId, 'RESEARCH_DATASET_IMPORTED', `import:${dataset.checksum.slice(0, 20)}`,
        null, JSON.stringify({ rowCount: dataset.players.length, inserted, updated, configuredSession }),
        `Imported ${dataset.sourceFilename}`, importedAt,
      );
      return { importId, importedAt, rowCount: dataset.players.length, inserted, updated, unchanged: false, configuredSession };
    })();
  }

  importPlayerIntelligence(profiles: PlayerIntelligenceInput[]) {
    return this.sqlite.transaction(() => {
      const upsert = this.sqlite.prepare(`INSERT INTO player_intelligence(
        player_id,profile_version,sample_season,games,age,roster_status,prior_team,current_team,
        fantasy_points_ppr,fantasy_ppg_ppr,late_season_ppg_ppr,carries,targets,receptions,scrimmage_yards,
        total_touchdowns,opportunities_per_game,target_share,air_yards_share,trend_score,floor_score,ceiling_score,
        role_summary,floor_case,ceiling_case,risk_note,evidence_json,source_count,data_quality,researched_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(player_id) DO UPDATE SET
        profile_version=excluded.profile_version,sample_season=excluded.sample_season,games=excluded.games,
        age=excluded.age,roster_status=excluded.roster_status,prior_team=excluded.prior_team,current_team=excluded.current_team,
        fantasy_points_ppr=excluded.fantasy_points_ppr,fantasy_ppg_ppr=excluded.fantasy_ppg_ppr,
        late_season_ppg_ppr=excluded.late_season_ppg_ppr,carries=excluded.carries,targets=excluded.targets,
        receptions=excluded.receptions,scrimmage_yards=excluded.scrimmage_yards,total_touchdowns=excluded.total_touchdowns,
        opportunities_per_game=excluded.opportunities_per_game,target_share=excluded.target_share,
        air_yards_share=excluded.air_yards_share,trend_score=excluded.trend_score,floor_score=excluded.floor_score,
        ceiling_score=excluded.ceiling_score,role_summary=excluded.role_summary,floor_case=excluded.floor_case,
        ceiling_case=excluded.ceiling_case,risk_note=excluded.risk_note,evidence_json=excluded.evidence_json,
        source_count=excluded.source_count,data_quality=excluded.data_quality,researched_at=excluded.researched_at`);
      const byIdentity = this.sqlite.prepare(`SELECT p.id FROM external_identities e
        JOIN players p ON p.id=e.player_id WHERE e.namespace='player' AND e.external_id=? LIMIT 1`);
      const byName = this.sqlite.prepare('SELECT id FROM players WHERE normalized_name=? ORDER BY excluded ASC LIMIT 1');
      let matched = 0;
      let unmatched = 0;
      for (const profile of profiles) {
        const identity = byIdentity.get(profile.nflverseId) as { id: string } | undefined;
        const named = byName.get(normalizePlayerName(profile.name)) as { id: string } | undefined;
        const playerId = identity?.id ?? named?.id;
        if (!playerId) { unmatched += 1; continue; }
        upsert.run(
          playerId, profile.profileVersion, profile.sampleSeason, profile.games, profile.age, profile.rosterStatus,
          profile.priorTeam, profile.currentTeam, profile.fantasyPointsPpr, profile.fantasyPpgPpr,
          profile.lateSeasonPpgPpr, profile.carries, profile.targets, profile.receptions, profile.scrimmageYards,
          profile.totalTouchdowns, profile.opportunitiesPerGame, profile.targetShare, profile.airYardsShare,
          profile.trendScore, profile.floorScore, profile.ceilingScore, profile.roleSummary, profile.floorCase,
          profile.ceilingCase, profile.riskNote, JSON.stringify(profile.evidence), profile.sourceCount,
          profile.dataQuality, profile.researchedAt,
        );
        matched += 1;
      }
      return { matched, unmatched, total: profiles.length };
    })();
  }

  listPlayers(): Player[] {
    const rows = this.sqlite.prepare(`SELECT p.*,
      pr.espn_rank AS research_espn_rank,pr.recommended_round AS research_recommended_round,
      pr.planned_pick AS research_planned_pick,pr.phase AS research_phase,pr.archetype AS research_archetype,
      pr.opportunity AS research_opportunity,pr.role_clarity AS research_role_clarity,pr.vision_score AS research_vision_score,
      pr.model_signal AS research_model_signal,pr.user_tag AS research_user_tag,pr.injury_news AS research_injury_news,
      pr.why_fits AS research_why_fits,pr.failure_case AS research_failure_case,pr.alternatives AS research_alternatives,
      pr.pairing_construction AS research_pairing_construction,pr.earliest_pick AS research_earliest_pick,
      pr.target_pick AS research_target_pick,pr.latest_pick AS research_latest_pick,pr.espn_source AS research_espn_source,
      pr.adp_source AS research_adp_source,pr.analysis_source AS research_analysis_source,
      pr.imported_draft_status AS research_imported_draft_status,pr.researched_at AS research_researched_at,
      pi.profile_version AS intelligence_profile_version,pi.sample_season AS intelligence_sample_season,
      pi.games AS intelligence_games,pi.age AS intelligence_age,pi.roster_status AS intelligence_roster_status,
      pi.prior_team AS intelligence_prior_team,pi.current_team AS intelligence_current_team,
      pi.fantasy_points_ppr AS intelligence_fantasy_points_ppr,pi.fantasy_ppg_ppr AS intelligence_fantasy_ppg_ppr,
      pi.late_season_ppg_ppr AS intelligence_late_season_ppg_ppr,pi.carries AS intelligence_carries,
      pi.targets AS intelligence_targets,pi.receptions AS intelligence_receptions,
      pi.scrimmage_yards AS intelligence_scrimmage_yards,pi.total_touchdowns AS intelligence_total_touchdowns,
      pi.opportunities_per_game AS intelligence_opportunities_per_game,pi.target_share AS intelligence_target_share,
      pi.air_yards_share AS intelligence_air_yards_share,pi.trend_score AS intelligence_trend_score,
      pi.floor_score AS intelligence_floor_score,pi.ceiling_score AS intelligence_ceiling_score,
      pi.role_summary AS intelligence_role_summary,pi.floor_case AS intelligence_floor_case,
      pi.ceiling_case AS intelligence_ceiling_case,pi.risk_note AS intelligence_risk_note,
      pi.evidence_json AS intelligence_evidence_json,pi.source_count AS intelligence_source_count,
      pi.data_quality AS intelligence_data_quality,pi.researched_at AS intelligence_researched_at
      FROM players p LEFT JOIN player_research pr ON pr.player_id=p.id
      LEFT JOIN player_intelligence pi ON pi.player_id=p.id ORDER BY p.overall_rank,p.id`).all() as Array<PlayerRow & PlayerResearchRow & PlayerIntelligenceRow>;
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

  private configFor(session: SessionRow): { teamCount: number; rounds: number; roster?: Partial<RosterRules>; positionLimits?: Partial<PositionLimits> } {
    const row = this.sqlite.prepare('SELECT config_json FROM league_config_versions WHERE id = ?').get(session.league_config_version_id) as { config_json: string };
    return JSON.parse(row.config_json) as { teamCount: number; rounds: number; roster?: Partial<RosterRules>; positionLimits?: Partial<PositionLimits> };
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
    const draftSize = config.teamCount * config.rounds;
    const pickedNumbers = new Set(picks.map((pick) => pick.overallPick));
    let currentOverallPick = 1;
    while (currentOverallPick <= draftSize && pickedNumbers.has(currentOverallPick)) currentOverallPick += 1;
    currentOverallPick = Math.min(draftSize, currentOverallPick);
    const nextUserPick = nextPickForSlot(currentOverallPick - 1, config.teamCount, config.rounds, session.user_slot);
    const recommendationContext = analyzeRecommendationContext({ players, picks, userSlot: session.user_slot, teamCount: config.teamCount, currentOverallPick, nextUserPick, rosterRules: config.roster, positionLimits: config.positionLimits });
    const recommendations = recommendPlayers({ players, picks, userSlot: session.user_slot, teamCount: config.teamCount, currentOverallPick, nextUserPick, rosterRules: config.roster, positionLimits: config.positionLimits, strategy: this.strategyFor(session) });
    const drafted = new Set(picks.map((pick) => pick.playerId));
    const conflicts = this.sqlite.prepare("SELECT id, overall_pick, candidate_json FROM reconciliation_conflicts WHERE session_id = ? AND status = 'OPEN'").all(session.id) as Array<{ id: string; overall_pick: number; candidate_json: string }>;
    const operation = session.parent_session_id
      ? this.sqlite.prepare("SELECT id, operation_type FROM operations WHERE state='COMPLETED' AND operation_type='RESET_SESSION' AND target_id=? ORDER BY created_at DESC LIMIT 1").get(session.parent_session_id) as { id: string; operation_type: string } | undefined
      : undefined;
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
      recommendationContext,
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

  reconcileFullSnapshot(input: { commandId: string; expectedRevision: number; picks: Array<{ overallPick: number; playerId: string; authority: Authority; reason?: string }> }) {
    const prior = this.idempotent(input.commandId);
    if (prior) return prior;
    return this.sqlite.transaction(() => {
      const session = this.getActiveSession();
      assertExpectedRevision(input.expectedRevision, session.revision);
      const config = this.configFor(session);
      const draftSize = config.teamCount * config.rounds;
      const ordered = [...input.picks].sort((left, right) => left.overallPick - right.overallPick);
      const pickNumbers = new Set<number>();
      const playerIds = new Set<string>();
      for (const pick of ordered) {
        if (pick.overallPick < 1 || pick.overallPick > draftSize || pickNumbers.has(pick.overallPick) || playerIds.has(pick.playerId)) {
          throw Object.assign(new Error('Full ESPN snapshot contains duplicate or invalid pick facts'), { statusCode: 409, code: 'SNAPSHOT_INVALID' });
        }
        pickNumbers.add(pick.overallPick); playerIds.add(pick.playerId);
      }
      const existing = this.sqlite.prepare('SELECT * FROM draft_picks WHERE session_id=? ORDER BY overall_pick').all(session.id) as PickRow[];
      const maxIncoming = ordered.at(-1)?.overallPick ?? 0;
      const maxExisting = existing.at(-1)?.overall_pick ?? 0;
      const contiguous = ordered.every((pick, index) => pick.overallPick === index + 1);
      if (!contiguous || maxIncoming < maxExisting) {
        const createdAt = now();
        const candidateJson = JSON.stringify({ summary: 'Full ESPN snapshot is incomplete or shorter than the preserved board', maxIncoming, maxExisting });
        const priorConflict = this.sqlite.prepare("SELECT id FROM reconciliation_conflicts WHERE session_id=? AND overall_pick=? AND candidate_json=? AND status='OPEN' LIMIT 1").get(session.id, Math.max(1, maxIncoming + 1), candidateJson);
        if (!priorConflict) this.sqlite.prepare('INSERT INTO reconciliation_conflicts VALUES (?,?,?,?,?,?)').run(randomUUID(), session.id, Math.max(1, maxIncoming + 1), candidateJson, 'OPEN', createdAt);
        const result = { sessionId: session.id, revision: session.revision, changed: false, incomplete: true, conflicts: 1 };
        this.sqlite.prepare('INSERT INTO command_results VALUES (?,?,?,?)').run(input.commandId, session.id, JSON.stringify(result), createdAt);
        return result;
      }

      const existingByPick = new Map(existing.map((pick) => [pick.overall_pick, pick]));
      const manualByPick = new Map(existing.filter((pick) => pick.locked_manual === 1).map((pick) => [pick.overall_pick, pick]));
      const manualByPlayer = new Map(existing.filter((pick) => pick.locked_manual === 1).map((pick) => [pick.player_id, pick]));
      const accepted: typeof ordered = [];
      let conflicts = 0;
      const createdAt = now();
      for (const pick of ordered) {
        const manualAtPick = manualByPick.get(pick.overallPick);
        const manualForPlayer = manualByPlayer.get(pick.playerId);
        if ((manualAtPick && manualAtPick.player_id !== pick.playerId) || (manualForPlayer && manualForPlayer.overall_pick !== pick.overallPick)) {
          const candidateJson = JSON.stringify({ summary: 'Automated full snapshot conflicts with a manual lock', playerId: pick.playerId });
          const conflictPick = manualForPlayer?.overall_pick ?? pick.overallPick;
          const priorConflict = this.sqlite.prepare("SELECT id FROM reconciliation_conflicts WHERE session_id=? AND overall_pick=? AND candidate_json=? AND status='OPEN' LIMIT 1").get(session.id, conflictPick, candidateJson);
          if (!priorConflict) this.sqlite.prepare('INSERT INTO reconciliation_conflicts VALUES (?,?,?,?,?,?)').run(randomUUID(), session.id, conflictPick, candidateJson, 'OPEN', createdAt);
          conflicts += 1;
          continue;
        }
        if (!manualAtPick) accepted.push(pick);
      }
      const currentAutomated = existing.filter((pick) => pick.locked_manual === 0);
      const unchanged = conflicts === 0 && currentAutomated.length === accepted.length
        && accepted.every((pick) => existingByPick.get(pick.overallPick)?.player_id === pick.playerId);
      if (unchanged) {
        const result = { sessionId: session.id, revision: session.revision, changed: false, confirmed: ordered.length, conflicts: 0 };
        this.sqlite.prepare('INSERT INTO command_results VALUES (?,?,?,?)').run(input.commandId, session.id, JSON.stringify(result), createdAt);
        return result;
      }

      this.sqlite.prepare('DELETE FROM draft_picks WHERE session_id=? AND locked_manual=0').run(session.id);
      for (const pick of accepted) {
        const priorPick = existingByPick.get(pick.overallPick);
        let revisionId = priorPick?.player_id === pick.playerId ? priorPick.accepted_revision_id : null;
        if (!revisionId) {
          revisionId = randomUUID();
          this.sqlite.prepare(`INSERT INTO pick_revisions(id,session_id,overall_pick,player_id,drafting_slot,authority,action,supersedes_revision_id,reason,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(revisionId, session.id, pick.overallPick, pick.playerId, pickCoordinates(pick.overallPick, config.teamCount).draftingSlot,
            pick.authority, priorPick ? 'CORRECT' : 'ADD', priorPick?.accepted_revision_id ?? null, pick.reason ?? 'Observed full ESPN snapshot', createdAt);
        }
        this.sqlite.prepare('INSERT INTO draft_picks VALUES (?,?,?,?,?,?,?,?,?)').run(
          session.id, pick.overallPick, pick.playerId, pickCoordinates(pick.overallPick, config.teamCount).draftingSlot,
          pick.authority, 0, revisionId, priorPick?.player_id === pick.playerId ? priorPick.revision : (priorPick?.revision ?? 0) + 1, createdAt,
        );
      }
      const nextRevision = session.revision + 1;
      this.sqlite.prepare("UPDATE draft_sessions SET state='ACTIVE', revision=? WHERE id=?").run(nextRevision, session.id);
      const result = { sessionId: session.id, revision: nextRevision, changed: true, confirmed: ordered.length - conflicts, conflicts };
      this.sqlite.prepare('INSERT INTO command_results VALUES (?,?,?,?)').run(input.commandId, session.id, JSON.stringify(result), createdAt);
      this.sqlite.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), 'draft_session', session.id, 'FULL_SNAPSHOT_RECONCILED', input.commandId,
        JSON.stringify({ pickCount: existing.length }), JSON.stringify(result), 'Atomic full-snapshot reconciliation', createdAt);
      return result;
    })();
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
          const candidateJson = JSON.stringify({ summary: 'Automated evidence conflicts with a manual lock', playerId: input.playerId });
          const priorConflict = this.sqlite.prepare("SELECT id FROM reconciliation_conflicts WHERE session_id=? AND overall_pick=? AND candidate_json=? AND status='OPEN' LIMIT 1").get(session.id, overallPick, candidateJson);
          if (!priorConflict) this.sqlite.prepare('INSERT INTO reconciliation_conflicts VALUES (?,?,?,?,?,?)').run(randomUUID(), session.id, overallPick, candidateJson, 'OPEN', createdAt);
          const result = { sessionId: session.id, revision: session.revision, conflict: true };
          this.sqlite.prepare('INSERT INTO command_results VALUES (?,?,?,?)').run(input.commandId, session.id, JSON.stringify(result), createdAt);
          return result;
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
      const active = this.getActiveSession();
      if (active.id !== result.childId) throw Object.assign(new Error('Reset undo is available only while its replacement session is active'), { statusCode: 409, code: 'UNDO_SESSION_CHANGED' });
      const createdAt = now();
      this.sqlite.prepare("UPDATE draft_sessions SET state='ARCHIVED', archived_at=? WHERE id=?").run(createdAt, result.childId);
      this.sqlite.prepare("UPDATE draft_sessions SET state='ACTIVE', archived_at=NULL, revision=revision+1 WHERE id=?").run(result.parentId);
      this.sqlite.prepare('UPDATE workspace_state SET active_session_id=?, updated_at=? WHERE singleton=1').run(result.parentId, createdAt);
      this.sqlite.prepare("UPDATE operations SET state='UNDONE' WHERE id=?").run(operationId);
      return { sessionId: result.parentId, undoneOperationId: operationId };
    })();
  }

  latestApplicableObservationAt(sessionId: string): string | null {
    const row = this.sqlite.prepare("SELECT MAX(observed_at) AS observed_at FROM draft_observations WHERE session_id=? AND parse_status = 'NORMALIZED'").get(sessionId) as { observed_at: string | null };
    return row.observed_at;
  }

  recordObservation(input: { sessionId: string; mechanism: string; kind: string; adapterSchemaVersion: string; externalDraftId?: string; observedAt?: string; dedupeKey: string; payload: unknown; parseStatus: string }) {
    const observedAt = input.observedAt ?? now();
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

  upsertObservedPlayers(players: ObservationPlayer[], source = 'espn', catalogPlayerCount = 0) {
    if (!players.length) return { upserted: 0, activatedCatalog: false };
    return this.sqlite.transaction(() => {
      const createdAt = now();
      let upserted = 0;
      for (const observed of players) {
        const mapped = this.sqlite.prepare(`SELECT p.* FROM external_identities e JOIN players p ON p.id=e.player_id
          WHERE e.source_id=? AND e.namespace='player' AND e.external_id=? AND e.scope_key='season:2026'`).get(source, observed.externalPlayerId) as PlayerRow | undefined;
        const nameMatches = mapped ? [] : this.sqlite.prepare('SELECT * FROM players WHERE normalized_name=? ORDER BY excluded ASC,id').all(normalizePlayerName(observed.playerName)) as PlayerRow[];
        const exactMatches = nameMatches.filter((candidate) => candidate.position === observed.position && candidate.team === observed.team);
        const named = mapped ?? (nameMatches.length === 1 ? nameMatches[0] : exactMatches.length === 1 ? exactMatches[0] : undefined);
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
      const activatedCatalog = catalogPlayerCount >= 30 && players.length >= catalogPlayerCount;
      if (activatedCatalog) this.sqlite.prepare("UPDATE players SET excluded=1 WHERE source LIKE 'Bundled demo fixture%'").run();
      return { upserted, activatedCatalog };
    })();
  }

  private rowToPlayer(row: PlayerRow & Partial<PlayerResearchRow> & Partial<PlayerIntelligenceRow>): Player {
    const research: PlayerResearch | null = row.research_espn_rank === undefined || row.research_espn_rank === null ? null : {
      espnRank: row.research_espn_rank,
      recommendedRound: row.research_recommended_round ?? null,
      plannedPick: row.research_planned_pick ?? null,
      phase: row.research_phase ?? '', archetype: row.research_archetype ?? '',
      opportunity: row.research_opportunity ?? 0, roleClarity: row.research_role_clarity ?? 0,
      visionScore: row.research_vision_score ?? 0, modelSignal: row.research_model_signal ?? '',
      userTag: row.research_user_tag ?? '', injuryNews: row.research_injury_news ?? '',
      whyFits: row.research_why_fits ?? '', failureCase: row.research_failure_case ?? '',
      alternatives: row.research_alternatives ?? '', pairingConstruction: row.research_pairing_construction ?? '',
      earliestPick: row.research_earliest_pick ?? null, targetPick: row.research_target_pick ?? null,
      latestPick: row.research_latest_pick ?? null, espnSource: row.research_espn_source ?? '',
      adpSource: row.research_adp_source ?? '', analysisSource: row.research_analysis_source ?? '',
      importedDraftStatus: row.research_imported_draft_status ?? '', researchedAt: row.research_researched_at ?? row.updated_at,
    };
    const intelligence: PlayerIntelligence | null = row.intelligence_profile_version === undefined || row.intelligence_profile_version === null ? null : {
      profileVersion: row.intelligence_profile_version, sampleSeason: row.intelligence_sample_season ?? 2025,
      games: row.intelligence_games ?? 0, age: row.intelligence_age ?? null,
      rosterStatus: row.intelligence_roster_status ?? null, priorTeam: row.intelligence_prior_team ?? null,
      currentTeam: row.intelligence_current_team ?? null, fantasyPointsPpr: row.intelligence_fantasy_points_ppr ?? null,
      fantasyPpgPpr: row.intelligence_fantasy_ppg_ppr ?? null, lateSeasonPpgPpr: row.intelligence_late_season_ppg_ppr ?? null,
      carries: row.intelligence_carries ?? null, targets: row.intelligence_targets ?? null,
      receptions: row.intelligence_receptions ?? null, scrimmageYards: row.intelligence_scrimmage_yards ?? null,
      totalTouchdowns: row.intelligence_total_touchdowns ?? null, opportunitiesPerGame: row.intelligence_opportunities_per_game ?? null,
      targetShare: row.intelligence_target_share ?? null, airYardsShare: row.intelligence_air_yards_share ?? null,
      trendScore: row.intelligence_trend_score ?? null, floorScore: row.intelligence_floor_score ?? 0,
      ceilingScore: row.intelligence_ceiling_score ?? 0, roleSummary: row.intelligence_role_summary ?? '',
      floorCase: row.intelligence_floor_case ?? '', ceilingCase: row.intelligence_ceiling_case ?? '',
      riskNote: row.intelligence_risk_note ?? '', evidence: JSON.parse(row.intelligence_evidence_json ?? '[]') as PlayerIntelligence['evidence'],
      sourceCount: row.intelligence_source_count ?? 1,
      dataQuality: (row.intelligence_data_quality ?? 'context-only') as PlayerIntelligence['dataQuality'],
      researchedAt: row.intelligence_researched_at ?? row.updated_at,
    };
    return {
      id: row.id, name: row.canonical_name, position: row.position, team: row.team, byeWeek: row.bye_week,
      overallRank: row.overall_rank, positionalRank: row.positional_rank, adp: row.adp, projection: row.projection,
      upside: row.upside, reliability: row.reliability, risk: row.risk, tier: row.tier, source: row.source,
      updatedAt: row.updated_at, excluded: row.excluded === 1, research, intelligence,
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
