import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DraftRepository } from '@fda/db';
import type { ResearchDataset } from '@fda/db';
import type { ObservationPlayer } from '../../packages/contracts/src/index.ts';

const repositories: DraftRepository[] = [];
function repository() {
  const repo = new DraftRepository({ databasePath: join(mkdtempSync(join(tmpdir(), 'fda-test-')), 'app.sqlite') });
  repositories.push(repo);
  return repo;
}
afterEach(() => { for (const repo of repositories.splice(0)) repo.sqlite.close(); });

describe('draft repository invariants', () => {
  it('imports a versioned research catalog idempotently and configures a blank practice session', () => {
    const repo = repository();
    const dataset: ResearchDataset = {
      checksum: 'a'.repeat(64), sourceFilename: 'research.xlsx', sourcePath: '/tmp/research.xlsx',
      leagueName: 'Research League', teamName: 'Research Team', teamCount: 8, rounds: 16, userSlot: 8,
      scoring: 'Full PPR; 4-point passing TDs', roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, DST: 1, K: 1, BENCH: 6 },
      thesis: 'Stable first turn, then upside', updatedAt: '2026-08-27T04:00:00.000Z',
      players: [
        {
          name: 'Jahmyr Gibbs', position: 'RB', team: 'DET', byeWeek: 6, espnRank: 1, modelRank: 1,
          positionalRank: 1, adp: 1, recommendedRound: 1, plannedPick: 8, phase: 'Anchor',
          archetype: 'Volume + contingency', reliability: 9, ceiling: 10, opportunity: 9, roleClarity: 9,
          risk: 3, visionScore: 10.2, modelSignal: 'Priority', userTag: 'Use Model', injuryNews: '',
          whyFits: 'Fits the build.', failureCase: 'Workload can fall.', alternatives: 'Take the next tier.',
          pairingConstruction: 'Pair with a WR.', earliestPick: 8, targetPick: 8, latestPick: 9,
          espnSource: 'https://example.com/espn', adpSource: 'https://example.com/adp',
          analysisSource: 'https://example.com/analysis', importedDraftStatus: 'Available', updatedAt: '2026-08-27T04:00:00.000Z',
        },
      ],
    };
    const first = repo.importResearchDataset(dataset);
    const repeat = repo.importResearchDataset(dataset);
    const imported = repo.listPlayers().filter((player) => player.research);
    expect(first).toMatchObject({ rowCount: 1, inserted: 1, unchanged: false, configuredSession: true });
    expect(repeat).toMatchObject({ rowCount: 1, inserted: 0, updated: 0, unchanged: true });
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ name: 'Jahmyr Gibbs', overallRank: 1, positionalRank: 1, adp: 1, upside: 100, reliability: 90, risk: 30 });
    expect(imported[0]?.research).toMatchObject({ visionScore: 10.2, targetPick: 8, whyFits: 'Fits the build.' });
    expect(repo.listPlayers().filter((player) => player.source.startsWith('Bundled demo')).every((player) => player.excluded)).toBe(true);
    const active = repo.getActiveSession();
    const config = repo.sqlite.prepare('SELECT config_json FROM league_config_versions WHERE id=?').get(active.league_config_version_id) as { config_json: string };
    expect(active.user_slot).toBe(8);
    expect(JSON.parse(config.config_json)).toMatchObject({ teamCount: 8, rounds: 16, source: 'research-workbook' });
    expect(repo.integrity().ok).toBe(true);
  });

  it('applies an idempotent manual pick and rejects stale revisions', () => {
    const repo = repository();
    const session = repo.getActiveSession();
    const player = repo.listPlayers()[0]!;
    const command = { commandId: 'manual-command-0001', expectedRevision: 0, playerId: player.id, overallPick: 1, authority: 'manual' as const };
    const first = repo.applyPick(command);
    const repeat = repo.applyPick(command);
    expect(repeat).toEqual(first);
    expect(repo.listPicks(session.id)).toHaveLength(1);
    expect(repo.listPicks(session.id)[0]?.lockedManual).toBe(true);
    expect(() => repo.applyPick({ ...command, commandId: 'manual-command-0002', playerId: repo.listPlayers()[1]!.id })).toThrow(/current revision is 1/);
  });

  it('enforces one drafted instance of a player', () => {
    const repo = repository();
    const player = repo.listPlayers()[0]!;
    repo.applyPick({ commandId: 'duplicate-command-01', expectedRevision: 0, playerId: player.id, overallPick: 1, authority: 'manual' });
    expect(() => repo.applyPick({ commandId: 'duplicate-command-02', expectedRevision: 1, playerId: player.id, overallPick: 2, authority: 'manual' })).toThrow(/already drafted/);
  });

  it('does not advance draft progress past the first missing pick', () => {
    const repo = repository();
    const players = repo.listPlayers();
    repo.applyPick({ commandId: 'gap-pick-one', expectedRevision: 0, playerId: players[0]!.id, overallPick: 1, authority: 'structured' });
    repo.applyPick({ commandId: 'gap-pick-three', expectedRevision: 1, playerId: players[1]!.id, overallPick: 3, authority: 'structured' });
    const state = repo.getState({ engine: 'healthy', database: 'healthy', chrome: 'stopped', espnAuth: 'unknown', pageDetected: false, pageAttached: false, capture: 'idle', lastObservationAt: null, lastReconciledAt: null, schemaVersion: 'test', engineInstanceId: 'test' });
    expect(state.session.currentOverallPick).toBe(2);
  });

  it('does not revise a pick when a later snapshot reports the same player', () => {
    const repo = repository();
    const player = repo.listPlayers()[0]!;
    repo.applyPick({ commandId: 'snapshot-command-01', expectedRevision: 0, playerId: player.id, overallPick: 1, authority: 'structured' });
    const repeated = repo.applyPick({ commandId: 'snapshot-command-02', expectedRevision: 1, playerId: player.id, overallPick: 1, authority: 'structured' }) as { revision: number; unchanged?: boolean };
    expect(repeated).toMatchObject({ revision: 1, unchanged: true });
    expect(repo.getActiveSession().revision).toBe(1);
    expect(repo.listPicks(repo.getActiveSession().id)).toHaveLength(1);
  });

  it('resets by archiving into a child and can undo without data loss', () => {
    const repo = repository();
    const parent = repo.getActiveSession();
    repo.applyPick({ commandId: 'reset-pick-command', expectedRevision: 0, playerId: repo.listPlayers()[0]!.id, overallPick: 1, authority: 'manual' });
    const reset = repo.resetSession({ commandId: 'reset-command-0001', expectedRevision: 1, confirmation: { sessionId: parent.id, mode: parent.mode, pickCount: 1 } }) as { operationId: string; childId: string };
    expect(repo.getActiveSession().id).toBe(reset.childId);
    expect(repo.listPicks(parent.id)).toHaveLength(1);
    repo.undoOperation(reset.operationId);
    expect(repo.getActiveSession().id).toBe(parent.id);
    expect(repo.listPicks(parent.id)).toHaveLength(1);
  });

  it('rejects an old reset undo after another draft became active', () => {
    const repo = repository();
    const parent = repo.getActiveSession();
    const reset = repo.resetSession({ commandId: 'reset-before-switch', expectedRevision: 0, confirmation: { sessionId: parent.id, mode: parent.mode, pickCount: 0 } }) as { operationId: string };
    const resetState = repo.getState({ engine: 'healthy', database: 'healthy', chrome: 'stopped', espnAuth: 'unknown', pageDetected: false, pageAttached: false, capture: 'idle', lastObservationAt: null, lastReconciledAt: null, schemaVersion: 'test', engineInstanceId: 'test' });
    expect(resetState.lastOperation).toMatchObject({ id: reset.operationId, undoable: true });
    repo.activateObservedSession({ externalDraftId: 'another-active-draft' });
    const active = repo.getActiveSession().id;
    expect(() => repo.undoOperation(reset.operationId)).toThrow(/replacement session is active/);
    expect(repo.getActiveSession().id).toBe(active);
    const activeRows = repo.sqlite.prepare("SELECT COUNT(*) AS count FROM draft_sessions WHERE state='ACTIVE'").get() as { count: number };
    expect(activeRows.count).toBe(1);
  });

  it('creates an isolated observed session only when an ESPN draft is explicitly bound', () => {
    const repo = repository();
    const practice = repo.getActiveSession();
    repo.applyPick({ commandId: 'practice-pick-before-live', expectedRevision: 0, playerId: repo.listPlayers()[0]!.id, overallPick: 1, authority: 'manual' });
    const bound = repo.activateObservedSession({ externalDraftId: 'espn-draft-2026', name: 'ESPN observed draft' });
    const live = repo.getActiveSession();
    expect(bound.created).toBe(true);
    expect(live.external_platform).toBe('espn');
    expect(live.external_draft_id).toBe('espn-draft-2026');
    expect(repo.listPicks(live.id)).toEqual([]);
    expect(repo.listPicks(practice.id)).toHaveLength(1);
    expect(() => repo.activateObservedSession({ externalDraftId: 'another-draft' })).toThrow(/different ESPN draft/);
  });

  it('lets an explicit tab bridge replace a finished ESPN draft and adopt its observed format', () => {
    const repo = repository();
    repo.activateObservedSession({ externalDraftId: 'old-draft' });
    repo.activateObservedSession({ externalDraftId: 'practice-419272', teamCount: 8, rounds: 16, userSlot: 8, replace: true });
    const active = repo.getActiveSession();
    const config = repo.sqlite.prepare('SELECT config_json FROM league_config_versions WHERE id=?').get(active.league_config_version_id) as { config_json: string };
    expect(active.external_draft_id).toBe('practice-419272');
    expect(active.user_slot).toBe(8);
    expect(JSON.parse(config.config_json)).toMatchObject({ teamCount: 8, rounds: 16, scoring: 'Full PPR; 4-point passing TDs', source: 'espn-observed' });
  });

  it('versions a changed ESPN roster config without violating the config name constraint', () => {
    const repo = repository();
    repo.activateObservedSession({ externalDraftId: 'practice-config-refresh', teamCount: 8, rounds: 16, userSlot: 8, replace: true });
    expect(() => repo.activateObservedSession({
      externalDraftId: 'practice-config-refresh', teamCount: 8, rounds: 16, userSlot: 8, replace: true,
      roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BENCH: 6 },
      positionLimits: { QB: 4, RB: 8, WR: 8, TE: 3, K: 3, DST: 3 },
    })).not.toThrow();
    const active = repo.getActiveSession();
    const config = repo.sqlite.prepare('SELECT name,version,config_json FROM league_config_versions WHERE id=?').get(active.league_config_version_id) as { name: string; version: number; config_json: string };
    expect(config).toMatchObject({ name: '8-team ESPN observed', version: 2 });
    expect(JSON.parse(config.config_json)).toMatchObject({ roster: { FLEX: 2, BENCH: 6 }, source: 'espn-observed-exact' });
    expect(repo.integrity().ok).toBe(true);
  });

  it('persists the one environment switch independently of session semantics', () => {
    const repo = repository();
    expect(repo.getDraftEnvironment()).toBe('PRACTICE');
    const sessionId = repo.getActiveSession().id;
    repo.setDraftEnvironment('LIVE');
    expect(repo.getDraftEnvironment()).toBe('LIVE');
    expect(repo.getActiveSession().id).toBe(sessionId);
    repo.setDraftEnvironment('PRACTICE');
    expect(repo.getDraftEnvironment()).toBe('PRACTICE');
  });

  it('activates a passively observed ESPN catalog without mixing in demo recommendations', () => {
    const repo = repository();
    const players: ObservationPlayer[] = Array.from({ length: 30 }, (_, index) => ({
      externalPlayerId: `observed-${index + 1}`, playerName: `Observed Player ${index + 1}`,
      position: index % 2 === 0 ? 'RB' : 'WR', team: 'BUF', adp: index + 1,
      projection: 300 - index, overallRank: index + 1, positionalRank: Math.floor(index / 2) + 1,
    }));
    const result = repo.upsertObservedPlayers(players, 'espn', players.length);
    expect(result).toEqual({ upserted: 30, activatedCatalog: true });
    expect(repo.listPlayers().filter((player) => player.source.startsWith('Bundled demo')).every((player) => player.excluded)).toBe(true);
    expect(repo.listPlayers().filter((player) => player.source.startsWith('ESPN passive'))).toHaveLength(30);
  });

  it('does not activate a declared catalog count that the observation did not contain', () => {
    const repo = repository();
    const player: ObservationPlayer = {
      externalPlayerId: 'observed-one', playerName: 'Observed One', position: 'RB', team: 'BUF',
      adp: 1, projection: 300, overallRank: 1, positionalRank: 1,
    };
    const result = repo.upsertObservedPlayers([player], 'espn', 30);
    expect(result).toEqual({ upserted: 1, activatedCatalog: false });
    expect(repo.listPlayers().some((candidate) => candidate.source.startsWith('Bundled demo') && !candidate.excluded)).toBe(true);
  });
});
