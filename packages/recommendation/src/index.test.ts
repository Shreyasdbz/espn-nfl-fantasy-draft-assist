import { describe, expect, it } from 'vitest';
import { demoPlayers } from '@fda/fixtures';
import type { DraftPick, Player, PlayerIntelligence } from '@fda/contracts';
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

function intelligence(rosterStatus: string, researchedAt: string): PlayerIntelligence {
  return {
    profileVersion: 'red-team-v1', sampleSeason: 2025, games: 17, age: 25, rosterStatus,
    priorTeam: 'ATL', currentTeam: 'ATL', fantasyPointsPpr: 250, fantasyPpgPpr: 15,
    lateSeasonPpgPpr: 16, carries: 200, targets: 60, receptions: 45, scrimmageYards: 1200,
    totalTouchdowns: 9, opportunitiesPerGame: 15, targetShare: 15, airYardsShare: 8,
    trendScore: 1, floorScore: 90, ceilingScore: 95, roleSummary: 'Red-team fixture.',
    floorCase: 'Fixture floor.', ceilingCase: 'Fixture ceiling.', riskNote: 'Fixture risk.',
    evidence: [{ source: 'https://example.com/evidence', kind: 'fixture', claim: 'Red-team status fixture.' }],
    sourceCount: 3, dataQuality: 'strong', researchedAt,
  };
}

describe('deterministic recommendations', () => {
  it('is stable and emits a complete factor breakdown', () => {
    const players = demoPlayers();
    const first = recommendPlayers({ players, picks: [], userSlot: 4, currentOverallPick: 4, nextUserPick: 17 });
    const second = recommendPlayers({ players, picks: [], userSlot: 4, currentOverallPick: 4, nextUserPick: 17 });
    expect(first).toEqual(second);
    expect(first[0]?.factors.map((factor) => factor.key)).toEqual(['reliability','upside','value','scarcity','roster','tier','market','replacement','projection','evidence','risk','bye']);
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

  it('derives recent market pressure from pick numbers rather than input arrival order', () => {
    const players = demoPlayers();
    const selected = [
      ...players.filter((player) => player.position === 'RB').slice(0, 6),
      ...players.filter((player) => player.position === 'WR').slice(0, 6),
    ];
    const picks = selected.map((player, index): DraftPick => ({
      overallPick: index + 1, round: Math.ceil((index + 1) / 8), pickInRound: (index % 8) + 1,
      draftingSlot: (index % 8) + 1, playerId: player.id, playerName: player.name,
      position: player.position, team: player.team, authority: 'snapshot', lockedManual: false,
      selectedAt: '2026-08-29T12:00:00.000Z',
    }));
    const ordered = analyzeDraftMarket({ players, picks, userSlot: 8, teamCount: 8, currentOverallPick: 13, nextUserPick: 24 });
    const reversed = analyzeDraftMarket({ players, picks: [...picks].reverse(), userSlot: 8, teamCount: 8, currentOverallPick: 13, nextUserPick: 24 });
    expect(reversed).toEqual(ordered);
  });

  it('keeps every candidate legal and every score finite across a deterministic scenario sweep', () => {
    const basePlayers = demoPlayers();
    for (let scenario = 0; scenario < 96; scenario += 1) {
      const playerOffset = scenario % basePlayers.length;
      const players = [...basePlayers.slice(playerOffset), ...basePlayers.slice(0, playerOffset)];
      const pickCount = scenario % 72;
      const draftedPlayers = [...basePlayers].sort((left, right) => left.overallRank - right.overallRank).slice(0, pickCount);
      const picks = draftedPlayers.map((player, index): DraftPick => {
        const overallPick = index + 1;
        const round = Math.ceil(overallPick / 8);
        const pickInRound = ((overallPick - 1) % 8) + 1;
        return {
          overallPick, round, pickInRound, draftingSlot: round % 2 === 1 ? pickInRound : 9 - pickInRound,
          playerId: player.id, playerName: player.name, position: player.position, team: player.team,
          authority: 'snapshot', lockedManual: false, selectedAt: '2026-08-29T12:00:00.000Z',
        };
      });
      const currentOverallPick = Math.min(128, pickCount + 1);
      const recommendations = recommendPlayers({ players, picks, userSlot: 8, teamCount: 8, currentOverallPick, nextUserPick: currentOverallPick, limit: 20 });
      const context = analyzeDraftMarket({ players, picks, userSlot: 8, teamCount: 8, currentOverallPick, nextUserPick: currentOverallPick });
      const draftedIds = new Set(picks.map((pick) => pick.playerId));
      for (const recommendation of recommendations) {
        expect(draftedIds.has(recommendation.playerId)).toBe(false);
        expect(Number.isFinite(recommendation.score)).toBe(true);
        expect(recommendation.factors.every((entry) => [entry.raw, entry.normalized, entry.weight, entry.contribution].every(Number.isFinite))).toBe(true);
      }
      expect(context.every((signal) => Number.isFinite(signal.pressure) && Number.isFinite(signal.upcomingDemand) && Number.isFinite(signal.tierDrop))).toBe(true);
    }
  });

  it('never recommends a player with a known inactive roster status', () => {
    const players = demoPlayers();
    const cut = { ...players[0]!, intelligence: intelligence('CUT', '2024-01-01T00:00:00.000Z'), updatedAt: '2024-01-01T00:00:00.000Z' };
    const active = { ...players[1]!, intelligence: intelligence('A01', '2026-08-29T00:00:00.000Z'), updatedAt: '2026-08-29T00:00:00.000Z' };
    const recommendations = recommendPlayers({ players: [cut, active, ...players.slice(2)], picks: [], userSlot: 8, teamCount: 8, currentOverallPick: 8, nextUserPick: 8 });
    expect(recommendations.map((item) => item.playerId)).not.toContain(cut.id);
  });

  it('uses full-PPR projection to break otherwise identical candidates independent of input order', () => {
    const source = demoPlayers().find((player) => player.position === 'RB')!;
    const low = { ...source, id: 'projection-low', name: 'Projection Low', projection: 0, overallRank: 1, positionalRank: 1, adp: 1 };
    const high = { ...source, id: 'projection-high', name: 'Projection High', projection: 400, overallRank: 1, positionalRank: 1, adp: 1 };
    const first = recommendPlayers({ players: [low, high], picks: [], userSlot: 8, teamCount: 8, currentOverallPick: 8, nextUserPick: 8 });
    const reversed = recommendPlayers({ players: [high, low], picks: [], userSlot: 8, teamCount: 8, currentOverallPick: 8, nextUserPick: 8 });
    expect(first[0]?.playerId).toBe(high.id);
    expect(reversed[0]?.playerId).toBe(high.id);
    expect(first.find((item) => item.playerId === high.id)!.score).toBeGreaterThan(first.find((item) => item.playerId === low.id)!.score);
  });

  it('emits no action after the user has no future turn even when capture is incomplete', () => {
    const players = demoPlayers();
    const picks = rosterPicks(players, ['QB', 'QB', 'RB', 'RB', 'RB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'WR', 'TE', 'TE', 'K'], 8);
    expect(recommendPlayers({ players, picks, userSlot: 8, teamCount: 8, currentOverallPick: 122, nextUserPick: null })).toEqual([]);
  });

  it('penalizes stale intelligence even when the entire captured catalog is old', () => {
    const players = demoPlayers().slice(0, 8).map((player) => ({
      ...player, updatedAt: '2024-01-01T00:00:00.000Z', intelligence: intelligence('A01', '2024-01-01T00:00:00.000Z'),
    }));
    const recommendation = recommendPlayers({ players, picks: [], userSlot: 8, teamCount: 8, currentOverallPick: 8, nextUserPick: 8 })[0]!;
    expect(recommendation.warnings).toContain('Player profile is stale');
    const evidence = recommendation.factors.find((entry) => entry.key === 'evidence')!;
    expect(evidence.contribution).toBeLessThan(0);
    expect(evidence.detail).toContain('Stale profile');
  });

  it('does not recommend K or DST in leagues with no such roster slots', () => {
    const players = demoPlayers();
    const picks = rosterPicks(players, ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'RB'], 8);
    const recommendations = recommendPlayers({
      players, picks, userSlot: 8, teamCount: 8, currentOverallPick: 120, nextUserPick: 120,
      rosterRules: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0, BENCH: 2 },
    });
    expect(recommendations.every((item) => item.position !== 'K' && item.position !== 'DST')).toBe(true);
  });

  it('does not continue a run bonus after every opponent reached the modeled depth target', () => {
    const players = demoPlayers();
    const picks = Array.from({ length: 7 }, (_, slot) => Array.from({ length: 5 }, (_unused, index): DraftPick => ({
      overallPick: slot * 5 + index + 1, round: Math.ceil((slot * 5 + index + 1) / 8), pickInRound: ((slot * 5 + index) % 8) + 1,
      draftingSlot: slot + 1, playerId: `depth-rb-${slot}-${index}`, playerName: `Depth RB ${slot}-${index}`,
      position: 'RB', team: 'FA', authority: 'snapshot', lockedManual: false, selectedAt: '2026-08-29T12:00:00.000Z',
    }))).flat();
    const rb = analyzeDraftMarket({ players, picks, userSlot: 8, teamCount: 8, currentOverallPick: 36, nextUserPick: 40 }).find((signal) => signal.position === 'RB')!;
    expect(rb.upcomingDemand).toBe(-0.3);
    expect(rb.pressure).toBeLessThanOrEqual(0);
    expect(rb.label).not.toBe('watch');
    expect(rb.label).not.toBe('run');
  });

  it('treats exhaustion after the sole remaining positional player as a real tier drop', () => {
    const players = demoPlayers();
    const runningBacks = players.filter((player) => player.position === 'RB');
    const picks = runningBacks.slice(1).map((player, index): DraftPick => ({
      overallPick: index + 1, round: Math.ceil((index + 1) / 8), pickInRound: (index % 8) + 1,
      draftingSlot: (index % 7) + 1, playerId: player.id, playerName: player.name, position: 'RB', team: player.team,
      authority: 'snapshot', lockedManual: false, selectedAt: '2026-08-29T12:00:00.000Z',
    }));
    const rb = analyzeDraftMarket({ players, picks, userSlot: 8, teamCount: 8, currentOverallPick: picks.length + 1, nextUserPick: picks.length + 15 }).find((signal) => signal.position === 'RB')!;
    expect(rb.availableInTier).toBe(1);
    expect(rb.tierDrop).toBeGreaterThan(0);
  });

  it('deduplicates repeated catalog IDs deterministically', () => {
    const players = demoPlayers();
    const duplicate = { ...players[0]!, name: 'Duplicate Alias', updatedAt: '2020-01-01T00:00:00.000Z' };
    const recommendations = recommendPlayers({ players: [duplicate, ...players], picks: [], userSlot: 8, teamCount: 8, currentOverallPick: 8, nextUserPick: 8, limit: 100 });
    expect(recommendations.filter((item) => item.playerId === players[0]!.id)).toHaveLength(1);
    expect(recommendations.find((item) => item.playerId === players[0]!.id)?.playerName).toBe(players[0]!.name);
  });
});
