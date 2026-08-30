import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DraftRepository } from '@fda/db';

describe('manual continuity under conflicting automation', () => {
  it('preserves a manual lock and opens a conflict', () => {
    const repo = new DraftRepository({ databasePath: join(mkdtempSync(join(tmpdir(), 'fda-lock-')), 'app.sqlite') });
    const players = repo.listPlayers();
    repo.applyPick({ commandId: 'manual-lock-command', expectedRevision: 0, playerId: players[0]!.id, overallPick: 1, authority: 'manual' });
    const result = repo.applyPick({ commandId: 'automated-conflict-command', expectedRevision: 1, playerId: players[1]!.id, overallPick: 1, authority: 'structured' }) as { conflict?: boolean };
    expect(result.conflict).toBe(true);
    expect(repo.listPicks(repo.getActiveSession().id)[0]?.playerId).toBe(players[0]!.id);
    repo.sqlite.close();
  });

  it('records a repeated automated conflict only once', () => {
    const repo = new DraftRepository({ databasePath: join(mkdtempSync(join(tmpdir(), 'fda-lock-repeat-')), 'app.sqlite') });
    const players = repo.listPlayers();
    repo.applyPick({ commandId: 'manual-repeat-command', expectedRevision: 0, playerId: players[0]!.id, overallPick: 1, authority: 'manual' });
    const command = { commandId: 'automated-repeat-command', expectedRevision: 1, playerId: players[1]!.id, overallPick: 1, authority: 'structured' as const };
    const first = repo.applyPick(command);
    const repeated = repo.applyPick(command);
    expect(repeated).toEqual(first);
    const conflicts = repo.sqlite.prepare('SELECT COUNT(*) AS count FROM reconciliation_conflicts').get() as { count: number };
    const revisions = repo.sqlite.prepare('SELECT COUNT(*) AS count FROM pick_revisions').get() as { count: number };
    expect(conflicts.count).toBe(1);
    expect(revisions.count).toBe(2);
    repo.close();
  });
});
