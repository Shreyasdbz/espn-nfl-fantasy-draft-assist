import type { DraftPick, Player, Recommendation, ScoreFactor } from '@fda/contracts';

export const ALGORITHM_VERSION = 'deterministic-v1';

export type Strategy = {
  reliabilityWeight: number;
  upsideWeight: number;
  valueWeight: number;
  scarcityWeight: number;
  rosterFitWeight: number;
  tierWeight: number;
  riskWeight: number;
  byeWeight: number;
};

export const defaultStrategy: Strategy = {
  reliabilityWeight: 0.16,
  upsideWeight: 0.2,
  valueWeight: 0.24,
  scarcityWeight: 0.13,
  rosterFitWeight: 0.12,
  tierWeight: 0.1,
  riskWeight: 0.12,
  byeWeight: 0.05,
};

const replacementRank: Record<Player['position'], number> = { QB: 14, RB: 44, WR: 48, TE: 14, K: 10, DST: 10 };
const starterTarget: Record<Player['position'], number> = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1 };

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function factor(key: string, label: string, raw: number, normalized: number, weight: number, detail: string): ScoreFactor {
  return { key, label, raw: round(raw), normalized: round(normalized, 4), weight, contribution: round(normalized * weight * 100), detail };
}

export function recommendPlayers(input: {
  players: Player[];
  picks: DraftPick[];
  userSlot: number;
  currentOverallPick: number;
  nextUserPick: number | null;
  strategy?: Strategy;
  limit?: number;
}): Recommendation[] {
  const strategy = input.strategy ?? defaultStrategy;
  const draftedIds = new Set(input.picks.map((pick) => pick.playerId));
  const roster = input.picks.filter((pick) => pick.draftingSlot === input.userSlot);
  const rosterCounts = roster.reduce<Record<string, number>>((acc, pick) => {
    acc[pick.position] = (acc[pick.position] ?? 0) + 1;
    return acc;
  }, {});
  const byes = new Map<number, number>();
  for (const pick of roster) if (pick.position !== 'K' && pick.position !== 'DST' && pick.team) {
    const player = input.players.find((candidate) => candidate.id === pick.playerId);
    if (player?.byeWeek) byes.set(player.byeWeek, (byes.get(player.byeWeek) ?? 0) + 1);
  }

  const recommendations = input.players
    .filter((player) => !draftedIds.has(player.id) && !player.excluded && (input.currentOverallPick >= 80 || (player.position !== 'K' && player.position !== 'DST')))
    .map((player) => {
      const valueRaw = input.currentOverallPick - (player.adp ?? player.overallRank);
      const valueNorm = Math.max(-1, Math.min(1, valueRaw / 24));
      const scarcityRaw = replacementRank[player.position] - player.positionalRank;
      const scarcityNorm = Math.max(-1, Math.min(1, scarcityRaw / replacementRank[player.position]));
      const needed = Math.max(0, starterTarget[player.position] - (rosterCounts[player.position] ?? 0));
      const rosterNorm = needed > 0 ? 1 : player.position === 'RB' || player.position === 'WR' ? 0.25 : -0.4;
      const tierNorm = Math.max(0, Math.min(1, (5 - player.tier) / 4));
      const byeOverlap = player.byeWeek ? byes.get(player.byeWeek) ?? 0 : 0;
      const byeNorm = player.byeWeek ? -Math.min(1, byeOverlap / 3) : 0;
      const factors = [
        factor('reliability', 'Reliability', player.reliability, player.reliability / 100, strategy.reliabilityWeight, `${round(player.reliability)} reliability index`),
        factor('upside', 'Upside', player.upside, player.upside / 100, strategy.upsideWeight, `${round(player.upside)} upside index`),
        factor('value', 'Value vs ADP', valueRaw, valueNorm, strategy.valueWeight, valueRaw >= 0 ? `${round(valueRaw, 1)} picks past ADP` : `${round(Math.abs(valueRaw), 1)}-pick reach`),
        factor('scarcity', 'Position scarcity', scarcityRaw, scarcityNorm, strategy.scarcityWeight, `${player.position}${player.positionalRank} vs replacement ${replacementRank[player.position]}`),
        factor('roster', 'Roster fit', needed, rosterNorm, strategy.rosterFitWeight, needed > 0 ? `Fills ${player.position} starter need` : 'Adds bench depth'),
        factor('tier', 'Tier leverage', player.tier, tierNorm, strategy.tierWeight, `Tier ${player.tier}`),
        factor('risk', 'Risk', player.risk, -(player.risk / 100), strategy.riskWeight, `${round(player.risk)} risk index`),
        factor('bye', 'Bye coverage', byeOverlap, byeNorm, strategy.byeWeight, player.byeWeek ? `${byeOverlap} roster overlap in week ${player.byeWeek}` : 'Bye week unknown'),
      ];
      const score = round(factors.reduce((sum, entry) => sum + entry.contribution, 0));
      const picksUntilNext = input.nextUserPick ? input.nextUserPick - input.currentOverallPick : 0;
      const adpDistance = (player.adp ?? player.overallRank) - input.currentOverallPick;
      const survivalBand: Recommendation['survivalBand'] = adpDistance > picksUntilNext + 8 ? 'likely' : adpDistance > Math.max(3, picksUntilNext - 5) ? 'coin flip' : 'unlikely';
      const warnings: string[] = [];
      if (player.byeWeek === null) warnings.push('Bye week unknown');
      if (player.risk >= 65) warnings.push('Elevated risk');
      if (!player.adp) warnings.push('ADP unavailable');
      if (byeOverlap >= 2) warnings.push(`Week ${player.byeWeek} roster overlap`);
      if (player.source.startsWith('ESPN passive')) warnings.push('ESPN identity is fresh; recommendation calibration is provisional');
      return { player, score, factors, survivalBand, warnings };
    })
    .sort((a, b) => b.score - a.score || a.player.overallRank - b.player.overallRank)
    .slice(0, input.limit ?? 12)
    .map((entry, index, all) => {
      const differentiators = [...entry.factors]
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
        .slice(0, 2);
      const alternative = all[index + 1]?.player.name;
      return {
        rank: index + 1,
        playerId: entry.player.id,
        playerName: entry.player.name,
        position: entry.player.position,
        team: entry.player.team,
        score: entry.score,
        survivalBand: entry.survivalBand,
        warnings: entry.warnings,
        factors: entry.factors,
        explanation: `${differentiators[0]?.label ?? 'Overall value'} and ${differentiators[1]?.label ?? 'roster fit'} drive the rank${alternative ? ` over ${alternative}` : ''}.`,
      } satisfies Recommendation;
    });

  return recommendations;
}
