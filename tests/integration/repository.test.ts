import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DraftRepository } from '@fda/db';
import type { ObservationPlayer } from '../../packages/contracts/src/index.ts';

const repositories: DraftRepository[] = [];
function repository() {
  const repo = new DraftRepository({ databasePath: join(mkdtempSync(join(tmpdir(), 'fda-test-')), 'app.sqlite') });
  repositories.push(repo);
  return repo;
}
afterEach(() => { for (const repo of repositories.splice(0)) repo.sqlite.close(); });

describe('draft repository invariants', () => {
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
    expect(JSON.parse(config.config_json)).toMatchObject({ teamCount: 8, rounds: 16, scoring: 'PPR', source: 'espn-observed' });
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
    const result = repo.upsertObservedPlayers(players);
    expect(result).toEqual({ upserted: 30, activatedCatalog: true });
    expect(repo.listPlayers().filter((player) => player.source.startsWith('Bundled demo')).every((player) => player.excluded)).toBe(true);
    expect(repo.listPlayers().filter((player) => player.source.startsWith('ESPN passive'))).toHaveLength(30);
  });
});
