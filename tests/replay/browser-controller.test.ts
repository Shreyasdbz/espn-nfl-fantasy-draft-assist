import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserController } from '../../apps/engine/src/browser-controller.ts';
import { DraftRepository } from '@fda/db';
import type { ObservationPlayer, TabBridgeObservation } from '../../packages/contracts/src/index.ts';

const repositories: DraftRepository[] = [];

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'fda-controller-test-'));
  const repository = new DraftRepository({ databasePath: join(root, 'app.sqlite') });
  repositories.push(repository);
  return { repository, controller: new BrowserController(repository, join(root, 'chrome'), () => undefined) };
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

const observedPlayers: ObservationPlayer[] = [
  { externalPlayerId: 'player-a', playerName: 'Player Alpha', position: 'RB', team: 'ATL', overallRank: 1, positionalRank: 1, adp: 1, projection: 300 },
  { externalPlayerId: 'player-b', playerName: 'Player Beta', position: 'WR', team: 'BUF', overallRank: 2, positionalRank: 1, adp: 2, projection: 290 },
];

function snapshot(input: {
  observedAt: string;
  externalPlayerId: string;
  playerName: string;
  players?: ObservationPlayer[];
}): TabBridgeObservation {
  return {
    externalDraftId: 'league-specific-practice-1', teamCount: 8, rounds: 16, userSlot: 8,
    observedAt: input.observedAt,
    picks: [{ overallPick: 1, externalPlayerId: input.externalPlayerId, playerName: input.playerName }],
    players: input.players ?? observedPlayers,
  };
}

describe('browser observation reconciliation', () => {
  it('is idempotent for a repeated full snapshot', async () => {
    const { repository, controller } = harness();
    const input = snapshot({ observedAt: '2026-08-29T12:00:00.000Z', externalPlayerId: 'player-a', playerName: 'Player Alpha' });
    await controller.ingestTabBridge(input);
    const firstRevision = repository.getActiveSession().revision;
    await controller.ingestTabBridge(input);
    expect(repository.getActiveSession().revision).toBe(firstRevision);
    expect(repository.listPicks(repository.getActiveSession().id, 8)).toHaveLength(1);
  });

  it('applies a newer correction exactly once', async () => {
    const { repository, controller } = harness();
    await controller.ingestTabBridge(snapshot({ observedAt: '2026-08-29T12:00:00.000Z', externalPlayerId: 'player-a', playerName: 'Player Alpha' }));
    await controller.ingestTabBridge(snapshot({ observedAt: '2026-08-29T12:00:02.000Z', externalPlayerId: 'player-b', playerName: 'Player Beta' }));
    expect(repository.getActiveSession().revision).toBe(2);
    expect(repository.listPicks(repository.getActiveSession().id, 8)[0]?.playerName).toBe('Player Beta');
  });

  it('does not let an older snapshot roll a newer correction backward when catalog details change', async () => {
    const { repository, controller } = harness();
    await controller.ingestTabBridge(snapshot({ observedAt: '2026-08-29T12:00:00.000Z', externalPlayerId: 'player-a', playerName: 'Player Alpha' }));
    await controller.ingestTabBridge(snapshot({ observedAt: '2026-08-29T12:00:03.000Z', externalPlayerId: 'player-b', playerName: 'Player Beta' }));
    await controller.ingestTabBridge(snapshot({
      observedAt: '2026-08-29T12:00:01.000Z', externalPlayerId: 'player-a', playerName: 'Player Alpha',
      players: [...observedPlayers].reverse(),
    }));
    expect(repository.getActiveSession().revision).toBe(2);
    expect(repository.listPicks(repository.getActiveSession().id, 8)[0]?.playerName).toBe('Player Beta');
    const latest = repository.sqlite.prepare('SELECT parse_status FROM draft_observations ORDER BY monotonic_seq DESC LIMIT 1').get() as { parse_status: string };
    expect(latest.parse_status).toBe('STALE');
  });

  it('does not let an older snapshot replace newer observed league configuration', async () => {
    const { repository, controller } = harness();
    await controller.ingestTabBridge(snapshot({ observedAt: '2026-08-29T12:00:03.000Z', externalPlayerId: 'player-b', playerName: 'Player Beta' }));
    await controller.ingestTabBridge({
      ...snapshot({ observedAt: '2026-08-29T12:00:01.000Z', externalPlayerId: 'player-a', playerName: 'Player Alpha' }),
      teamCount: 10, rounds: 18, userSlot: 5,
    });
    const state = repository.getState({ engine: 'healthy', database: 'healthy', chrome: 'observing', espnAuth: 'authenticated', pageDetected: true, pageAttached: true, capture: 'healthy', lastObservationAt: null, lastReconciledAt: null, schemaVersion: 'test', engineInstanceId: 'test' });
    expect(state.session).toMatchObject({ teamCount: 8, rounds: 16, userSlot: 8 });
    expect(state.picks[0]?.playerName).toBe('Player Beta');
  });

  it('does not let a quarantined empty observation poison the freshness watermark', async () => {
    const { repository, controller } = harness();
    await controller.ingestTabBridge({
      externalDraftId: 'league-specific-practice-1', teamCount: 8, rounds: 16, userSlot: 8,
      observedAt: '2026-08-29T12:00:05.000Z', picks: [], players: [],
    });
    await controller.ingestTabBridge(snapshot({ observedAt: '2026-08-29T12:00:04.000Z', externalPlayerId: 'player-a', playerName: 'Player Alpha' }));
    expect(repository.getActiveSession().revision).toBe(1);
    expect(repository.listPicks(repository.getActiveSession().id, 8)[0]?.playerName).toBe('Player Alpha');
    const statuses = repository.sqlite.prepare('SELECT parse_status FROM draft_observations ORDER BY monotonic_seq').all() as Array<{ parse_status: string }>;
    expect(statuses.map((row) => row.parse_status)).toEqual(['QUARANTINED', 'NORMALIZED']);
  });

  it('degrades capture for an empty quarantined snapshot', async () => {
    const { controller } = harness();
    const health = await controller.ingestTabBridge({
      externalDraftId: 'league-specific-practice-1', teamCount: 8, rounds: 16, userSlot: 8,
      observedAt: '2026-08-29T12:00:05.000Z', picks: [], players: [],
    });
    expect(health.capture).toBe('degraded');
    expect(health.lastReconciledAt).toBeNull();
  });

  it('accepts a real empty pre-draft board when the player catalog is present', async () => {
    const { controller } = harness();
    const health = await controller.ingestTabBridge({
      externalDraftId: 'league-specific-practice-1', teamCount: 8, rounds: 16, userSlot: 8,
      observedAt: '2026-08-29T12:00:05.000Z', picks: [], players: observedPlayers, catalogPlayerCount: observedPlayers.length,
    });
    expect(health.capture).toBe('healthy');
    expect(health.lastReconciledAt).not.toBeNull();
  });

  it('applies a two-player swap atomically without tripping player uniqueness', async () => {
    const { repository, controller } = harness();
    await controller.ingestTabBridge({
      externalDraftId: 'league-specific-practice-1', teamCount: 8, rounds: 16, userSlot: 8,
      observedAt: '2026-08-29T12:00:00.000Z', players: observedPlayers,
      picks: [
        { overallPick: 1, externalPlayerId: 'player-a', playerName: 'Player Alpha' },
        { overallPick: 2, externalPlayerId: 'player-b', playerName: 'Player Beta' },
      ],
    });
    await controller.ingestTabBridge({
      externalDraftId: 'league-specific-practice-1', teamCount: 8, rounds: 16, userSlot: 8,
      observedAt: '2026-08-29T12:00:02.000Z', players: observedPlayers,
      picks: [
        { overallPick: 1, externalPlayerId: 'player-b', playerName: 'Player Beta' },
        { overallPick: 2, externalPlayerId: 'player-a', playerName: 'Player Alpha' },
      ],
    });
    expect(repository.getActiveSession().revision).toBe(2);
    expect(repository.listPicks(repository.getActiveSession().id, 8).map((pick) => pick.playerName)).toEqual(['Player Beta', 'Player Alpha']);
  });

  it('preserves the board and opens one conflict when a newer full snapshot shrinks', async () => {
    const { repository, controller } = harness();
    await controller.ingestTabBridge({
      externalDraftId: 'league-specific-practice-1', teamCount: 8, rounds: 16, userSlot: 8,
      observedAt: '2026-08-29T12:00:00.000Z', players: observedPlayers,
      picks: [
        { overallPick: 1, externalPlayerId: 'player-a', playerName: 'Player Alpha' },
        { overallPick: 2, externalPlayerId: 'player-b', playerName: 'Player Beta' },
      ],
    });
    const shorter: TabBridgeObservation = {
      externalDraftId: 'league-specific-practice-1', teamCount: 8, rounds: 16, userSlot: 8,
      observedAt: '2026-08-29T12:00:02.000Z', players: observedPlayers,
      picks: [{ overallPick: 1, externalPlayerId: 'player-a', playerName: 'Player Alpha' }],
    };
    await controller.ingestTabBridge(shorter);
    await controller.ingestTabBridge(shorter);
    expect(repository.getActiveSession().revision).toBe(1);
    expect(repository.listPicks(repository.getActiveSession().id, 8).map((pick) => pick.playerName)).toEqual(['Player Alpha', 'Player Beta']);
    const conflicts = repository.sqlite.prepare("SELECT COUNT(*) AS count FROM reconciliation_conflicts WHERE status='OPEN'").get() as { count: number };
    expect(conflicts.count).toBe(1);
    expect(controller.health().capture).toBe('degraded');
  });
});
