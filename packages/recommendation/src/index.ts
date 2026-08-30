import type {
  DraftPick, MarketSignal, Player, Position, PositionLimits as ContractPositionLimits,
  Recommendation, RosterRules as ContractRosterRules, ScoreFactor,
} from '@fda/contracts';

export const ALGORITHM_VERSION = 'league-market-v3';

export type Strategy = {
  reliabilityWeight: number; upsideWeight: number; valueWeight: number; scarcityWeight: number;
  rosterFitWeight: number; tierWeight: number; marketWeight: number; replacementWeight: number;
  projectionWeight: number; evidenceWeight: number; riskWeight: number; byeWeight: number;
};
export type RosterRules = ContractRosterRules;
export type PositionLimits = ContractPositionLimits;

export type RosterContext = {
  phase: 'foundation' | 'balance' | 'endgame'; picksRemaining: number; startersOpen: number;
  gate: 'none' | 'forced-needs'; positionCounts: Record<Position, number>; rosterRules: RosterRules;
  positionLimits: PositionLimits; openSlots: RosterRules; requiredPositions: Position[];
  saturatedPositions: Position[]; marketSignals: MarketSignal[];
};

export const defaultStrategy: Strategy = {
  reliabilityWeight: 0.12, upsideWeight: 0.13, valueWeight: 0.14, scarcityWeight: 0.09,
  rosterFitWeight: 0.13, tierWeight: 0.08, marketWeight: 0.11, replacementWeight: 0.11,
  projectionWeight: 0.1, evidenceWeight: 0.06, riskWeight: 0.08, byeWeight: 0.03,
};
export const defaultRosterRules: RosterRules = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BENCH: 6 };
export const defaultPositionLimits: PositionLimits = { QB: 4, RB: 8, WR: 8, TE: 3, K: 3, DST: 3 };

const positions: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
const flexPositions = new Set<Position>(['RB', 'WR', 'TE']);
const replacementRank: Record<Position, number> = { QB: 14, RB: 44, WR: 48, TE: 14, K: 10, DST: 10 };

function clamp(value: number, minimum = -1, maximum = 1): number { return Math.min(maximum, Math.max(minimum, value)); }
function round(value: number, digits = 2): number { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
function factor(key: string, label: string, raw: number, normalized: number, weight: number, detail: string): ScoreFactor {
  return { key, label, raw: round(raw), normalized: round(normalized, 4), weight: round(weight, 4), contribution: round(normalized * weight * 100), detail };
}
function normalizedRules(input?: Partial<RosterRules>): RosterRules {
  return Object.fromEntries(Object.entries(defaultRosterRules).map(([key, fallback]) => [key, Math.max(0, Math.round(input?.[key as keyof RosterRules] ?? fallback))])) as RosterRules;
}
function normalizedLimits(input?: Partial<PositionLimits>): PositionLimits {
  return Object.fromEntries(Object.entries(defaultPositionLimits).map(([key, fallback]) => [key, Math.max(0, Math.round(input?.[key as Position] ?? fallback))])) as PositionLimits;
}
function totalRosterSize(rules: RosterRules): number { return rules.QB + rules.RB + rules.WR + rules.TE + rules.FLEX + rules.K + rules.DST + rules.BENCH; }
function canFillOpenSlot(position: Position, openSlots: RosterRules): boolean { return openSlots[position] > 0 || (flexPositions.has(position) && openSlots.FLEX > 0); }
function uniqueCatalog(players: Player[]): Player[] {
  const byId = new Map<string, Player>();
  for (const player of players) {
    const existing = byId.get(player.id);
    if (!existing || player.updatedAt > existing.updatedAt
      || (player.updatedAt === existing.updatedAt && player.overallRank < existing.overallRank)
      || (player.updatedAt === existing.updatedAt && player.overallRank === existing.overallRank && player.name.localeCompare(existing.name) < 0)) byId.set(player.id, player);
  }
  return [...byId.values()];
}
function knownInactive(player: Player): boolean {
  const status = player.intelligence?.rosterStatus?.trim().toUpperCase();
  return !!status && ['CUT', 'RELEASED', 'RETIRED', 'RET', 'SUSPENDED', 'INACTIVE'].includes(status);
}

export function analyzeRosterConstruction(input: { picks: DraftPick[]; userSlot: number; rosterRules?: Partial<RosterRules>; positionLimits?: Partial<PositionLimits> }): RosterContext {
  const rules = normalizedRules(input.rosterRules);
  const positionLimits = normalizedLimits(input.positionLimits);
  const roster = input.picks.filter((pick) => pick.draftingSlot === input.userSlot);
  const positionCounts = Object.fromEntries(positions.map((position) => [position, 0])) as Record<Position, number>;
  for (const pick of roster) positionCounts[pick.position] += 1;
  const dedicatedFilled = Object.fromEntries(positions.map((position) => [position, Math.min(rules[position], positionCounts[position])])) as Record<Position, number>;
  const flexEligibleSurplus = (['RB', 'WR', 'TE'] as Position[]).reduce((sum, position) => sum + Math.max(0, positionCounts[position] - rules[position]), 0);
  const flexFilled = Math.min(rules.FLEX, flexEligibleSurplus);
  const starterFilled = positions.reduce((sum, position) => sum + dedicatedFilled[position], 0) + flexFilled;
  const benchFilled = Math.max(0, roster.length - starterFilled);
  const openSlots: RosterRules = {
    QB: Math.max(0, rules.QB - dedicatedFilled.QB), RB: Math.max(0, rules.RB - dedicatedFilled.RB),
    WR: Math.max(0, rules.WR - dedicatedFilled.WR), TE: Math.max(0, rules.TE - dedicatedFilled.TE),
    FLEX: Math.max(0, rules.FLEX - flexFilled), K: Math.max(0, rules.K - dedicatedFilled.K),
    DST: Math.max(0, rules.DST - dedicatedFilled.DST), BENCH: Math.max(0, rules.BENCH - benchFilled),
  };
  const startersOpen = openSlots.QB + openSlots.RB + openSlots.WR + openSlots.TE + openSlots.FLEX + openSlots.K + openSlots.DST;
  const picksRemaining = Math.max(0, totalRosterSize(rules) - roster.length);
  const requiredPositions = positions.filter((position) => canFillOpenSlot(position, openSlots) && positionCounts[position] < positionLimits[position]);
  const preCompletionCaps: Record<Position, number> = {
    QB: Math.min(positionLimits.QB, Math.max(1, rules.QB)), RB: Math.min(positionLimits.RB, rules.RB + rules.FLEX),
    WR: Math.min(positionLimits.WR, rules.WR + rules.FLEX), TE: Math.min(positionLimits.TE, rules.TE + Math.min(1, rules.FLEX)),
    K: Math.min(positionLimits.K, Math.max(1, rules.K)), DST: Math.min(positionLimits.DST, Math.max(1, rules.DST)),
  };
  const saturatedPositions = positions.filter((position) => positionCounts[position] >= positionLimits[position]
    || (startersOpen > 0 && positionCounts[position] >= preCompletionCaps[position] && !canFillOpenSlot(position, openSlots)));
  const gate = startersOpen > 0 && startersOpen >= picksRemaining ? 'forced-needs' : 'none';
  const filledRatio = roster.length / Math.max(1, totalRosterSize(rules));
  const phase: RosterContext['phase'] = gate === 'forced-needs' || picksRemaining <= 4 ? 'endgame' : filledRatio < 0.34 ? 'foundation' : 'balance';
  return { phase, picksRemaining, startersOpen, gate, positionCounts, rosterRules: rules, positionLimits, openSlots, requiredPositions, saturatedPositions, marketSignals: [] };
}

function dynamicStrategy(baseInput: Partial<Strategy> | undefined, context: RosterContext): Strategy {
  const base = { ...defaultStrategy, ...baseInput };
  const multipliers = context.gate === 'forced-needs'
    ? [0.7, 0.45, 0.4, 0.65, 4.5, 0.45, 0.5, 0.65, 0.8, 0.8, 0.8, 0.8]
    : context.phase === 'foundation' ? [1, 1.2, 1.1, 1.05, 0.9, 1.2, 0.95, 1.15, 1.1, 0.9, 0.8, 0.35]
      : context.phase === 'balance' ? [1.05, 1, 0.9, 1.05, 1.7, 1, 1.2, 1.1, 1, 1, 1, 0.7]
        : [1.1, 0.75, 0.6, 0.9, 2.7, 0.7, 1, 0.9, 0.9, 1.1, 0.95, 1];
  return {
    reliabilityWeight: base.reliabilityWeight * multipliers[0]!, upsideWeight: base.upsideWeight * multipliers[1]!,
    valueWeight: base.valueWeight * multipliers[2]!, scarcityWeight: base.scarcityWeight * multipliers[3]!,
    rosterFitWeight: base.rosterFitWeight * multipliers[4]!, tierWeight: base.tierWeight * multipliers[5]!,
    marketWeight: base.marketWeight * multipliers[6]!, replacementWeight: base.replacementWeight * multipliers[7]!,
    projectionWeight: base.projectionWeight * multipliers[8]!, evidenceWeight: base.evidenceWeight * multipliers[9]!,
    riskWeight: base.riskWeight * multipliers[10]!, byeWeight: base.byeWeight * multipliers[11]!,
  };
}

function depthTarget(position: Position, rules: RosterRules, limits: PositionLimits): number {
  const target = position === 'RB' || position === 'WR' ? rules[position] + Math.ceil(rules.FLEX / 2) + Math.ceil(rules.BENCH * 0.25)
    : position === 'TE' ? rules.TE + (rules.FLEX > 0 ? 1 : 0) : position === 'QB' ? rules.QB + (rules.BENCH >= 5 ? 1 : 0) : rules[position];
  return Math.min(target, limits[position]);
}
function snakeSlot(overallPick: number, teamCount: number): number {
  const round = Math.ceil(overallPick / teamCount); const pickInRound = ((overallPick - 1) % teamCount) + 1;
  return round % 2 === 1 ? pickInRound : teamCount - pickInRound + 1;
}
function playerQuality(player: Player, poolSize: number): number {
  const rank = clamp(1 - (player.overallRank - 1) / Math.max(1, poolSize - 1), 0, 1);
  const floor = (player.intelligence?.floorScore ?? player.reliability) / 100;
  const ceiling = (player.intelligence?.ceilingScore ?? player.upside) / 100;
  const research = player.research ? clamp(player.research.visionScore / 10, 0, 1) : rank;
  return clamp(rank * 0.35 + floor * 0.25 + ceiling * 0.2 + research * 0.2, 0, 1);
}
function demandForPosition(picks: DraftPick[], slot: number, position: Position, rules: RosterRules, limits: PositionLimits): number {
  const context = analyzeRosterConstruction({ picks, userSlot: slot, rosterRules: rules, positionLimits: limits });
  const count = context.positionCounts[position];
  if (count >= limits[position]) return -1;
  if (context.openSlots[position] > 0) return 1;
  if (flexPositions.has(position) && context.openSlots.FLEX > 0) return 0.78;
  if (count < depthTarget(position, rules, limits)) return 0.25;
  return -0.3;
}

export function analyzeDraftMarket(input: {
  players: Player[]; picks: DraftPick[]; userSlot: number; teamCount: number; currentOverallPick: number;
  nextUserPick: number | null; rosterRules?: Partial<RosterRules>; positionLimits?: Partial<PositionLimits>;
}): MarketSignal[] {
  const rules = normalizedRules(input.rosterRules); const limits = normalizedLimits(input.positionLimits);
  const orderedPicks = [...input.picks].sort((left, right) => left.overallPick - right.overallPick);
  const drafted = new Set(orderedPicks.map((pick) => pick.playerId));
  const catalog = uniqueCatalog(input.players);
  const available = catalog.filter((player) => !drafted.has(player.id) && !player.excluded && !knownInactive(player));
  const recent = orderedPicks.slice(-Math.max(6, input.teamCount));
  const nextPick = input.nextUserPick ?? input.currentOverallPick;
  const upcomingTurns = Array.from({ length: Math.max(0, nextPick - input.currentOverallPick) }, (_, index) => {
    const overallPick = input.currentOverallPick + index;
    return { overallPick, slot: snakeSlot(overallPick, input.teamCount) };
  }).filter((turn) => turn.slot !== input.userSlot);
  const demandTargets = Object.fromEntries(positions.map((position) => [position, depthTarget(position, rules, limits)])) as Record<Position, number>;
  const totalTarget = positions.reduce((sum, position) => sum + demandTargets[position], 0);
  return positions.map((position) => {
    const pool = available.filter((player) => player.position === position).sort((a, b) => playerQuality(b, input.players.length) - playerQuality(a, input.players.length) || a.overallRank - b.overallRank);
    const recentPicks = recent.filter((pick) => pick.position === position).length;
    const expected = recent.length * demandTargets[position] / Math.max(1, totalTarget);
    const runIntensity = clamp((recentPicks - expected) / Math.max(1, expected * 1.4));
    const simulatedPicks = [...orderedPicks];
    let demandSum = 0;
    for (const turn of upcomingTurns) {
      const demand = demandForPosition(simulatedPicks, turn.slot, position, rules, limits);
      demandSum += demand;
      if (demand > 0) {
        simulatedPicks.push({
          overallPick: turn.overallPick, round: Math.ceil(turn.overallPick / input.teamCount),
          pickInRound: ((turn.overallPick - 1) % input.teamCount) + 1, draftingSlot: turn.slot,
          playerId: `market:${position}:${turn.overallPick}`, playerName: `Modeled ${position} demand`,
          position, team: null, authority: 'snapshot', lockedManual: false, selectedAt: 'modeled',
        });
      }
    }
    const upcomingDemand = upcomingTurns.length ? clamp(demandSum / upcomingTurns.length) : 0;
    const best = pool[0]; const availableInTier = best ? pool.filter((player) => player.tier === best.tier).length : 0;
    const postRunIndex = Math.max(1, Math.ceil(upcomingTurns.length * Math.max(0, upcomingDemand)));
    const bestQuality = best ? playerQuality(best, input.players.length) : 0;
    const laterQuality = pool[postRunIndex] ? playerQuality(pool[postRunIndex]!, input.players.length) : 0;
    const tierDrop = round(Math.max(0, (bestQuality - laterQuality) * 100), 1);
    const cliff = clamp(tierDrop / 18, 0, 1); const supplyRelief = availableInTier >= Math.max(3, upcomingTurns.length + 1) ? 0.3 : 0;
    const rawPressure = upcomingDemand <= 0
      ? Math.min(0, clamp(upcomingDemand * 0.7 - supplyRelief))
      : clamp(runIntensity * 0.38 + upcomingDemand * 0.37 + cliff * 0.25 - supplyRelief);
    const pressure = round(upcomingTurns.length > 0 && upcomingDemand <= -0.75 ? Math.min(-0.25, rawPressure) : rawPressure, 4);
    const label: MarketSignal['label'] = pressure >= 0.62 ? 'run' : pressure >= 0.3 ? 'watch' : pressure <= -0.2 ? 'cool' : 'stable';
    const detail = upcomingTurns.length ? `${recentPicks} of the last ${recent.length} picks; ${upcomingTurns.length} opponent pick${upcomingTurns.length === 1 ? '' : 's'} before your turn; ${availableInTier} left in the top available tier.` : `${recentPicks} of the last ${recent.length} picks; you are on the clock; ${availableInTier} left in the top available tier.`;
    return { position, recentPicks, upcomingDemand: round(upcomingDemand, 4), availableInTier, tierDrop, pressure, label, detail };
  });
}

export function analyzeRecommendationContext(input: Parameters<typeof analyzeDraftMarket>[0]): RosterContext {
  return { ...analyzeRosterConstruction(input), marketSignals: analyzeDraftMarket(input) };
}

export function recommendPlayers(input: {
  players: Player[]; picks: DraftPick[]; userSlot: number; teamCount?: number; currentOverallPick: number;
  nextUserPick: number | null; rosterRules?: Partial<RosterRules>; positionLimits?: Partial<PositionLimits>;
  strategy?: Partial<Strategy>; limit?: number;
}): Recommendation[] {
  const rules = normalizedRules(input.rosterRules); const limits = normalizedLimits(input.positionLimits);
  const teamCount = input.teamCount ?? Math.max(2, ...input.picks.map((pick) => pick.draftingSlot), 10);
  if (input.nextUserPick === null) return [];
  const context = analyzeRecommendationContext({ ...input, teamCount, rosterRules: rules, positionLimits: limits });
  const strategy = dynamicStrategy(input.strategy, context); const draftedIds = new Set(input.picks.map((pick) => pick.playerId));
  const roster = input.picks.filter((pick) => pick.draftingSlot === input.userSlot);
  const catalog = uniqueCatalog(input.players);
  const available = catalog.filter((player) => !draftedIds.has(player.id) && !player.excluded && !knownInactive(player));
  const quality = new Map(available.map((player) => [player.id, playerQuality(player, input.players.length)]));
  const positionPools = new Map(positions.map((position) => [position, available.filter((player) => player.position === position).sort((a, b) => (quality.get(b.id) ?? 0) - (quality.get(a.id) ?? 0))]));
  const projectionRanges = new Map(positions.map((position) => {
    const projections = (positionPools.get(position) ?? []).map((player) => player.projection).filter(Number.isFinite);
    return [position, { minimum: Math.min(...projections, 0), maximum: Math.max(...projections, 0) }] as const;
  }));
  const catalogAsOf = Math.max(Date.now(), ...catalog.map((player) => new Date(player.updatedAt).getTime()).filter(Number.isFinite), 0);
  const byes = new Map<number, number>();
  for (const pick of roster) if (pick.position !== 'K' && pick.position !== 'DST' && pick.team) { const player = input.players.find((candidate) => candidate.id === pick.playerId); if (player?.byeWeek) byes.set(player.byeWeek, (byes.get(player.byeWeek) ?? 0) + 1); }
  const specialTeamsWindow = context.picksRemaining <= 4 || context.gate === 'forced-needs';
  const required = new Set(context.requiredPositions); const saturated = new Set(context.saturatedPositions);
  const signals = new Map(context.marketSignals.map((signal) => [signal.position, signal]));
  return available.filter((player) => {
    if (context.picksRemaining === 0) return false;
    if ((player.position === 'K' && rules.K === 0) || (player.position === 'DST' && rules.DST === 0)) return false;
    if ((player.position === 'K' || player.position === 'DST') && !specialTeamsWindow) return false;
    if (context.positionCounts[player.position] >= limits[player.position]) return false;
    if (context.gate === 'forced-needs' && !required.has(player.position)) return false;
    return !saturated.has(player.position);
  }).map((player) => {
    const effectiveReliability = player.intelligence?.floorScore ?? player.reliability;
    const effectiveUpside = player.intelligence?.ceilingScore ?? player.upside;
    const valueRaw = input.currentOverallPick - (player.adp ?? player.overallRank); const valueNorm = clamp(valueRaw / 24);
    const scarcityRaw = replacementRank[player.position] - player.positionalRank; const scarcityNorm = clamp(scarcityRaw / replacementRank[player.position]);
    const fillsDedicated = context.openSlots[player.position] > 0; const fillsFlex = flexPositions.has(player.position) && context.openSlots.FLEX > 0;
    const currentCount = context.positionCounts[player.position]; const target = depthTarget(player.position, rules, limits);
    const urgency = context.startersOpen / Math.max(1, context.picksRemaining);
    const rosterNorm = context.gate === 'forced-needs' ? 1 : fillsDedicated ? Math.min(1, 0.78 + urgency) : fillsFlex ? Math.min(0.92, 0.62 + urgency) : currentCount < target ? 0.28 : -0.78;
    const rosterDetail = context.gate === 'forced-needs' ? `Required to complete ${context.requiredPositions.join('/')} with ${context.picksRemaining} pick${context.picksRemaining === 1 ? '' : 's'} left` : fillsDedicated ? `Fills open ${player.position} starter slot` : fillsFlex ? `Fills one of ${context.openSlots.FLEX} open FLEX slots` : currentCount < target ? `${currentCount}/${target} planned ${player.position} depth` : `${player.position} depth is already ${currentCount}/${target}`;
    const tierNorm = clamp((5 - player.tier) / 4, 0, 1); const byeOverlap = player.byeWeek ? byes.get(player.byeWeek) ?? 0 : 0; const byeNorm = player.byeWeek ? -Math.min(1, byeOverlap / 3) : 0;
    const market = signals.get(player.position)!; const needMultiplier = rosterNorm >= 0.6 ? 1 : rosterNorm >= 0 ? 0.55 : 0.2; const marketNorm = clamp(market.pressure * needMultiplier);
    const pool = positionPools.get(player.position) ?? []; const replacement = pool[Math.min(pool.length - 1, Math.max(1, Math.ceil(replacementRank[player.position] / Math.max(1, teamCount))))];
    const replacementRaw = ((quality.get(player.id) ?? 0) - (replacement ? quality.get(replacement.id) ?? 0 : 0)) * 100; const replacementNorm = clamp(replacementRaw / 35, 0, 1);
    const projectionRange = projectionRanges.get(player.position)!;
    const projectionNorm = projectionRange.maximum > projectionRange.minimum ? clamp((player.projection - projectionRange.minimum) / (projectionRange.maximum - projectionRange.minimum), 0, 1) : 0;
    const profileAt = player.intelligence ? new Date(player.intelligence.researchedAt).getTime() : 0;
    const profileAgeDays = profileAt && catalogAsOf ? Math.max(0, (catalogAsOf - profileAt) / 86_400_000) : Number.POSITIVE_INFINITY;
    const staleProfile = profileAgeDays > 180;
    const evidenceNorm = staleProfile ? -0.45 : player.intelligence?.dataQuality === 'strong' ? 1 : player.intelligence?.dataQuality === 'partial' ? 0.45 : player.intelligence ? -0.15 : -0.45;
    const factors = [
      factor('reliability', 'Reliability', effectiveReliability, effectiveReliability / 100, strategy.reliabilityWeight, player.intelligence ? `${round(effectiveReliability)} position-specific floor score from weekly production and role stability` : `${round(effectiveReliability)} workbook reliability index`),
      factor('upside', 'Upside', effectiveUpside, effectiveUpside / 100, strategy.upsideWeight, player.intelligence ? `${round(effectiveUpside)} ceiling score; late-season delta ${player.intelligence.trendScore && player.intelligence.trendScore > 0 ? '+' : ''}${round(player.intelligence.trendScore ?? 0, 1)} PPG` : `${round(effectiveUpside)} upside index`),
      factor('value', 'Price discipline', valueRaw, valueNorm, strategy.valueWeight, valueRaw >= 0 ? `${round(valueRaw, 1)} picks past ADP` : `${round(Math.abs(valueRaw), 1)}-pick reach`),
      factor('scarcity', 'Position scarcity', scarcityRaw, scarcityNorm, strategy.scarcityWeight, `${player.position}${player.positionalRank} vs ${player.position} replacement range ${replacementRank[player.position]}`),
      factor('roster', 'Roster fit', currentCount, rosterNorm, strategy.rosterFitWeight, rosterDetail),
      factor('tier', 'Tier leverage', player.tier, tierNorm, strategy.tierWeight, `Tier ${player.tier}; ${market.availableInTier} player${market.availableInTier === 1 ? '' : 's'} remain in the top available ${player.position} tier`),
      factor('market', 'Draft market', market.pressure, marketNorm, strategy.marketWeight, market.detail),
      factor('replacement', 'Value over replacement', replacementRaw, replacementNorm, strategy.replacementWeight, `${round(replacementRaw, 1)} quality points above the next ${player.position} replacement band`),
      factor('projection', 'Full-PPR projection', player.projection, projectionNorm, strategy.projectionWeight, `${round(player.projection, 1)} projected full-PPR points relative to available ${player.position}s`),
      factor('evidence', 'Evidence quality', player.intelligence?.sourceCount ?? 0, evidenceNorm, strategy.evidenceWeight, staleProfile
        ? `Stale profile last researched ${player.intelligence?.researchedAt ?? 'at an unknown date'}; evidence confidence is reduced`
        : player.intelligence ? `${player.intelligence.dataQuality} profile across ${player.intelligence.sourceCount} evidence sources` : 'No current usage profile; rank inputs carry more uncertainty'),
      factor('risk', 'Risk', player.risk, -(player.risk / 100), strategy.riskWeight, `${round(player.risk)} risk index`),
      factor('bye', 'Bye coverage', byeOverlap, byeNorm, strategy.byeWeight, player.byeWeek ? `${byeOverlap} roster overlap in week ${player.byeWeek}` : 'Bye week unknown'),
    ];
    const score = round(factors.reduce((sum, entry) => sum + entry.contribution, 0));
    const picksUntilNext = input.nextUserPick ? Math.max(0, input.nextUserPick - input.currentOverallPick) : 0;
    const adpDistance = (player.adp ?? player.overallRank) - input.currentOverallPick; const marketAdjustedDistance = adpDistance - Math.max(0, market.pressure) * Math.max(2, picksUntilNext * 0.5);
    const survivalBand: Recommendation['survivalBand'] = marketAdjustedDistance > picksUntilNext + 7 ? 'likely' : marketAdjustedDistance > Math.max(2, picksUntilNext - 5) ? 'coin flip' : 'unlikely';
    const warnings: string[] = [];
    if (player.byeWeek === null) warnings.push('Bye week unknown'); if (player.risk >= 65) warnings.push('Elevated risk'); if (!player.adp) warnings.push('ADP unavailable');
    if (byeOverlap >= 2) warnings.push(`Week ${player.byeWeek} roster overlap`); if (rosterNorm < 0) warnings.push(`${player.position} depth already satisfied`); if (market.label === 'run') warnings.push(`${player.position} run: tier may not survive`);
    if (context.gate === 'forced-needs') warnings.push('Mandatory roster completion gate'); if (player.source.startsWith('ESPN passive')) warnings.push('ESPN identity is fresh; recommendation calibration is provisional');
    if (!player.intelligence) warnings.push('No current usage profile'); if (player.intelligence?.priorTeam && player.intelligence.currentTeam && player.intelligence.priorTeam !== player.intelligence.currentTeam) warnings.push('Changed teams for 2026');
    if (staleProfile) warnings.push('Player profile is stale');
    return { player, score, factors, survivalBand, warnings, rosterNorm, market };
  }).sort((a, b) => b.score - a.score || a.player.overallRank - b.player.overallRank || a.player.id.localeCompare(b.player.id)).slice(0, input.limit ?? 12).map((entry, index, all) => {
    const differentiators = [...entry.factors].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 2); const alternative = all[index + 1]?.player.name;
    const rosterLead = entry.rosterNorm >= 0.75 ? `${entry.factors.find((item) => item.key === 'roster')!.detail}. ` : '';
    const marketLead = entry.market.label === 'run' ? `${entry.player.position} demand is accelerating, but the boost is capped by roster need and tier value. ` : '';
    return { rank: index + 1, playerId: entry.player.id, playerName: entry.player.name, position: entry.player.position, team: entry.player.team, score: entry.score, survivalBand: entry.survivalBand, warnings: entry.warnings, factors: entry.factors, explanation: `${rosterLead}${marketLead}${differentiators[0]?.label ?? 'Overall value'} and ${differentiators[1]?.label ?? 'roster fit'} drive the rank${alternative ? ` over ${alternative}` : ''}.` } satisfies Recommendation;
  });
}
