import { describe, expect, it } from 'vitest';
import { demoPlayers } from '@fda/fixtures';
import { recommendPlayers } from './index.ts';

describe('deterministic recommendations', () => {
  it('is stable and emits a complete factor breakdown', () => {
    const players = demoPlayers();
    const first = recommendPlayers({ players, picks: [], userSlot: 4, currentOverallPick: 4, nextUserPick: 17 });
    const second = recommendPlayers({ players, picks: [], userSlot: 4, currentOverallPick: 4, nextUserPick: 17 });
    expect(first).toEqual(second);
    expect(first[0]?.factors.map((factor) => factor.key)).toEqual(['reliability','upside','value','scarcity','roster','tier','risk','bye']);
    expect(first[0]?.explanation).toContain('drive the rank');
  });

  it('never recommends a drafted or explicitly excluded player', () => {
    const players = demoPlayers();
    players[1]!.excluded = true;
    const drafted = players[0]!;
    const recommendations = recommendPlayers({
      players,
      picks: [{ overallPick: 1, round: 1, pickInRound: 1, draftingSlot: 1, playerId: drafted.id, playerName: drafted.name, position: drafted.position, team: drafted.team, authority: 'manual', lockedManual: true, selectedAt: new Date().toISOString() }],
      userSlot: 4, currentOverallPick: 2, nextUserPick: 4,
    });
    expect(recommendations.map((item) => item.playerId)).not.toContain(drafted.id);
    expect(recommendations.map((item) => item.playerId)).not.toContain(players[1]!.id);
  });
});

