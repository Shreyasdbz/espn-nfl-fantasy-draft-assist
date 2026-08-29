import { describe, expect, it } from 'vitest';
import { demoPlayers } from '@fda/fixtures';
import type { DraftPick, Player } from '@fda/contracts';
import { analyzeDraftMarket, recommendPlayers } from './index.ts';

function rosterPicks(players: Player[], positions: Player['position'][], userSlot = 4): DraftPick[] {
  const used = new Set<string>();
  return positions.map((position, index) => {
    const player = players.find((candidate) => candidate.position === position && !used.has(candidate.id))!;
    used.add(player.id);
    return {
      overallPick: index + 1, round: 1, pickInRound: index + 1, draftingSlot: userSlot,
      playerId: player.id, playerName: player.name, position: player.position, team: player.team,
      authority: 'manual', lockedManual: true, selectedAt: '2026-08-27T12:00:00.000Z',
    };
  });
}

describe('deterministic recommendations', () => {
  it('is stable and emits a complete factor breakdown', () => {
    const players = demoPlayers();
    const first = recommendPlayers({ players, picks: [], userSlot: 4, currentOverallPick: 4, nextUserPick: 17 });
    const second = recommendPlayers({ players, picks: [], userSlot: 4, currentOverallPick: 4, nextUserPick: 17 });
    expect(first).toEqual(second);
    expect(first[0]?.factors.map((factor) => factor.key)).toEqual(['reliability','upside','value','scarcity','roster','tier','market','replacement','evidence','risk','bye']);
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

  it('suppresses a fifth wide receiver while other starter positions remain open', () => {
    const players = demoPlayers();
    const picks = rosterPicks(players, ['WR', 'WR', 'WR', 'WR']);
    const recommendations = recommendPlayers({ players, picks, userSlot: 4, currentOverallPick: 33, nextUserPick: 48 });
    expect(recommendations).not.toHaveLength(0);
    expect(recommendations.every((item) => item.position !== 'WR')).toBe(true);
    expect(recommendations.some((item) => item.position === 'RB' || item.position === 'TE' || item.position === 'QB')).toBe(true);
  });

  it('hard-gates the final selection to the only unfilled roster position', () => {
    const players = demoPlayers();
    const picks = rosterPicks(players, ['QB', 'QB', 'RB', 'RB', 'RB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'WR', 'TE', 'TE', 'K']);
    const recommendations = recommendPlayers({ players, picks, userSlot: 4, currentOverallPick: 120, nextUserPick: 120 });
    expect(recommendations).not.toHaveLength(0);
    expect(recommendations.every((item) => item.position === 'DST')).toBe(true);
    expect(recommendations[0]?.warnings).toContain('Mandatory roster completion gate');
  });

  it('increases roster-fit weight as the draft moves from foundation to balance', () => {
    const players = demoPlayers();
    const early = recommendPlayers({ players, picks: [], userSlot: 4, currentOverallPick: 4, nextUserPick: 17 });
    const picks = rosterPicks(players, ['RB', 'WR', 'RB', 'WR', 'TE', 'QB']);
    const middle = recommendPlayers({ players, picks, userSlot: 4, currentOverallPick: 49, nextUserPick: 64 });
    const earlyWeight = early[0]!.factors.find((item) => item.key === 'roster')!.weight;
    const middleWeight = middle[0]!.factors.find((item) => item.key === 'roster')!.weight;
    expect(middleWeight).toBeGreaterThan(earlyWeight);
  });

  it('returns no recommendation after the roster is complete', () => {
    const players = demoPlayers();
    const picks = rosterPicks(players, ['QB', 'QB', 'RB', 'RB', 'RB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'WR', 'TE', 'TE', 'K', 'DST']);
    expect(recommendPlayers({ players, picks, userSlot: 4, currentOverallPick: 129, nextUserPick: null })).toEqual([]);
  });

  it('raises RB market pressure after an opponent run when the tier is thinning', () => {
    const players = demoPlayers();
    const runningBacks = players.filter((player) => player.position === 'RB').slice(0, 6);
    const picks = runningBacks.map((player, index): DraftPick => ({
      overallPick: index + 1, round: 1, pickInRound: index + 1, draftingSlot: index + 1,
      playerId: player.id, playerName: player.name, position: player.position, team: player.team,
      authority: 'snapshot', lockedManual: false, selectedAt: '2026-08-29T12:00:00.000Z',
    }));
    const market = analyzeDraftMarket({ players, picks, userSlot: 8, teamCount: 8, currentOverallPick: 7, nextUserPick: 8 });
    const rb = market.find((signal) => signal.position === 'RB')!;
    const wr = market.find((signal) => signal.position === 'WR')!;
    expect(rb.recentPicks).toBe(6);
    expect(rb.pressure).toBeGreaterThan(wr.pressure);
    expect(['watch', 'run']).toContain(rb.label);
  });

  it('does not let a run justify a severe reach over elite available value', () => {
    const players = demoPlayers();
    const runningBacks = players.filter((player) => player.position === 'RB');
    const picks = runningBacks.slice(0, Math.max(0, runningBacks.length - 1)).map((player, index): DraftPick => ({
      overallPick: index + 1, round: Math.ceil((index + 1) / 8), pickInRound: (index % 8) + 1, draftingSlot: (index % 7) + 1,
      playerId: player.id, playerName: player.name, position: player.position, team: player.team,
      authority: 'snapshot', lockedManual: false, selectedAt: '2026-08-29T12:00:00.000Z',
    }));
    const lastRb = runningBacks.at(-1)!;
    lastRb.overallRank = 180; lastRb.adp = 180; lastRb.tier = 5; lastRb.reliability = 35; lastRb.upside = 42;
    const recommendations = recommendPlayers({ players, picks, userSlot: 8, teamCount: 8, currentOverallPick: Math.max(8, picks.length + 1), nextUserPick: null });
    expect(recommendations[0]?.position).not.toBe('RB');
  });

  it('enforces ESPN position maximums independently of starter construction', () => {
    const players = demoPlayers();
    const picks = rosterPicks(players, ['TE', 'TE', 'TE'], 4);
    const recommendations = recommendPlayers({ players, picks, userSlot: 4, teamCount: 8, currentOverallPick: 25, nextUserPick: 40, positionLimits: { TE: 3 } });
    expect(recommendations.every((item) => item.position !== 'TE')).toBe(true);
  });

  it('does not chase a prior run when every upcoming opponent is already at the position cap', () => {
    const players = demoPlayers();
    const picks = Array.from({ length: 7 }, (_, slot) => Array.from({ length: 8 }, (_unused, index): DraftPick => ({
      overallPick: slot * 8 + index + 1, round: slot + 1, pickInRound: index + 1, draftingSlot: slot + 1,
      playerId: `max-rb-${slot + 1}-${index + 1}`, playerName: `Max RB ${slot + 1}-${index + 1}`, position: 'RB', team: 'FA',
      authority: 'snapshot', lockedManual: false, selectedAt: '2026-08-29T12:00:00.000Z',
    }))).flat();
    const rb = analyzeDraftMarket({ players, picks, userSlot: 8, teamCount: 8, currentOverallPick: 74, nextUserPick: 88 }).find((signal) => signal.position === 'RB')!;
    expect(rb.upcomingDemand).toBe(-1);
    expect(rb.pressure).toBeLessThanOrEqual(0);
    expect(rb.label).toBe('cool');
  });

  it('models slot 8 turn picks as immediate, then sees fourteen opponent picks', () => {
    const players = demoPlayers();
    const atTurn = analyzeDraftMarket({ players, picks: [], userSlot: 8, teamCount: 8, currentOverallPick: 9, nextUserPick: 9 });
    const afterTurn = analyzeDraftMarket({ players, picks: [], userSlot: 8, teamCount: 8, currentOverallPick: 10, nextUserPick: 24 });
    expect(atTurn[0]?.detail).toContain('you are on the clock');
    expect(afterTurn[0]?.detail).toContain('14 opponent picks before your turn');
  });
});
