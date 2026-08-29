import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import type { PlayerIntelligenceInput } from '@fda/db';

type CsvRow = Record<string, string>;

const STATS_SOURCE = 'https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2025.csv';
const ROSTER_SOURCE = 'https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_2026.csv';
const POSITION_RESEARCH: Record<string, string> = {
  QB: 'https://sst.fantasylife.com/articles/fantasy/quarterback-tiers-for-fantasy-football-2026-jayden-daniels',
  RB: 'https://sst.fantasylife.com/articles/fantasy/running-back-tiers-for-2026-fantasy-football',
  WR: 'https://sst.fantasylife.com/articles/fantasy/what-matters-for-wide-receivers-in-2026-fantasy-football',
  TE: 'https://sst.fantasylife.com/articles/fantasy/tight-end-tiers-for-2026-fantasy-football-can-colston-loveland',
  K: 'https://github.com/nflverse/nflverse-data/blob/main/README.Rmd',
  DST: 'https://www.fantasylife.com/articles/fantasy/defense-dst-rankings-for-2026-fantasy-football',
};

const DST_CONTEXT: Array<{ name: string; team: string; rank: number; role: string; risk: string }> = [
  { name: 'Texans D/ST', team: 'HOU', rank: 1, role: 'Elite pass rush and coverage foundation; second in points allowed per drive and three-and-out rate in 2025.', risk: 'Draft cost is the primary concern; D/ST scoring remains matchup-sensitive.' },
  { name: 'Broncos D/ST', team: 'DEN', rank: 2, role: 'Pressure-led unit: third in pressure rate and first in sack rate in 2025.', risk: 'Turnover and touchdown scoring can still swing weekly outcomes.' },
  { name: 'Seahawks D/ST', team: 'SEA', rank: 3, role: 'Allowed the fewest points per drive and delivered a top-eight fantasy week in 10 of 17 games.', risk: 'An elite 2025 finish creates natural year-over-year regression risk.' },
  { name: 'Rams D/ST', team: 'LAR', rank: 4, role: 'Top-five fantasy unit with a top-four pressure rate, then added high-end pass-rush and secondary talent.', risk: 'New personnel must translate quickly; do not pay for name value alone.' },
  { name: 'Eagles D/ST', team: 'PHI', rank: 5, role: 'A top-seven 2025 unit reinforced its pass rush and secondary for 2026.', risk: 'Divisional offenses and weekly game script still matter more than season rank.' },
  { name: 'Chargers D/ST', team: 'LAC', rank: 7, role: 'Top-10 across efficiency measures with one of the league’s stronger interception totals.', risk: 'Interceptions are less stable than pressure and defensive success rate.' },
  { name: 'Ravens D/ST', team: 'BAL', rank: 8, role: 'An offseason pass-rush upgrade targets the pressure and sack weaknesses that limited the 2025 unit.', risk: 'The rebound case depends on fixing a bottom-tier pressure profile.' },
  { name: 'Patriots D/ST', team: 'NE', rank: 9, role: 'Top-10 fantasy finish in 2025 with enough personnel quality to remain draftable.', risk: 'A much harder 2026 schedule makes this a clear regression candidate.' },
  { name: 'Steelers D/ST', team: 'PIT', rank: 10, role: 'Three consecutive top-eight fantasy finishes provide a dependable multi-year floor.', risk: 'An aging core and the first post-Tomlin season cap confidence in the ceiling.' },
  { name: 'Browns D/ST', team: 'CLE', rank: 13, role: 'Still carries defensive-line depth, but the 2026 unit must replace an elite individual pressure source.', risk: 'Losing Myles Garrett materially lowers the proven pass-rush ceiling.' },
  { name: 'Chiefs D/ST', team: 'KC', rank: 15, role: 'Coaching continuity keeps the unit viable as a matchup play.', risk: 'Major secondary departures follow a season with little fantasy relevance.' },
  { name: 'Lions D/ST', team: 'DET', rank: 16, role: 'A healthier secondary plus a favorable 2026 schedule creates a streaming path.', risk: 'The case depends on health improvement rather than a strong 2025 baseline.' },
];

function numeric(value: string | undefined): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function ageOn(date: string, year: number): number | null {
  const birth = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return null;
  return round((Date.UTC(year, 8, 1) - birth.getTime()) / 31_556_952_000, 1);
}

function percentile(values: number[], value: number): number {
  if (!values.length) return 50;
  const lower = values.filter((candidate) => candidate < value).length;
  const equal = values.filter((candidate) => candidate === value).length;
  return round(((lower + equal / 2) / values.length) * 100);
}

function quantile(values: number[], probability: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index); const upper = Math.ceil(index);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function weightedShare(rows: CsvRow[], numerator: string, share: string): number {
  let numeratorTotal = 0; let denominatorTotal = 0;
  for (const row of rows) {
    const value = numeric(row[numerator]); const fraction = numeric(row[share]);
    if (value <= 0 || fraction <= 0) continue;
    numeratorTotal += value; denominatorTotal += value / fraction;
  }
  return denominatorTotal > 0 ? numeratorTotal / denominatorTotal : 0;
}

function shrink(value: number, games: number, center = 50): number {
  const sampleWeight = Math.min(1, games / 12);
  return center + (value - center) * sampleWeight;
}

function describeRole(position: string, opportunities: number, targetShare: number, ppg: number, trend: number): string {
  if (position === 'QB') {
    if (opportunities >= 5) return `Dual-threat profile: ${round(opportunities)} rushes per game supplement ${round(ppg)} PPR points per game.`;
    return `Pocket-led profile: ${round(ppg)} PPR points per game with ${round(opportunities)} rushes per game.`;
  }
  if (position === 'RB') {
    const workload = opportunities >= 18 ? 'Every-week workload' : opportunities >= 13 ? 'Committee lead workload' : 'Contingent workload';
    return `${workload}: ${round(opportunities)} carries plus targets per game and ${round(targetShare * 100)}% average target share.`;
  }
  if (position === 'WR' || position === 'TE') {
    const role = targetShare >= 0.25 ? 'Offense-driving target role' : targetShare >= 0.18 ? 'Stable primary/secondary role' : 'Efficiency-dependent role';
    return `${role}: ${round(targetShare * 100)}% average target share and ${round(ppg)} PPR points per game.`;
  }
  if (position === 'K') return `Scoring-opportunity profile built from ${round(ppg)} fantasy points per game in 2025.`;
  return 'Current context profile; team-defense value remains schedule- and matchup-sensitive.';
}

export function readPlayerIntelligence(statsPath: string, rosterPath: string): {
  checksum: string;
  profiles: PlayerIntelligenceInput[];
} {
  const statsBytes = readFileSync(statsPath);
  const rosterBytes = readFileSync(rosterPath);
  const stats = parse(statsBytes, { columns: true, skip_empty_lines: true }) as CsvRow[];
  const rosters = parse(rosterBytes, { columns: true, skip_empty_lines: true }) as CsvRow[];
  const currentRoster = new Map(rosters.map((row) => [row.gsis_id, row]));
  const teamGames = new Map<string, Set<string>>();
  for (const row of stats) {
    if (row.season_type !== 'REG' || !row.team || !row.game_id) continue;
    const games = teamGames.get(row.team) ?? new Set<string>();
    games.add(row.game_id); teamGames.set(row.team, games);
  }
  const byPlayer = new Map<string, CsvRow[]>();
  for (const row of stats) {
    if (row.season_type !== 'REG') continue;
    const rows = byPlayer.get(row.player_id) ?? [];
    rows.push(row);
    byPlayer.set(row.player_id, rows);
  }

  const aggregates = [...byPlayer.entries()].map(([playerId, rows]) => {
    const ordered = [...rows].sort((a, b) => numeric(a.week) - numeric(b.week));
    const games = new Set(ordered.map((row) => row.game_id).filter(Boolean)).size;
    const fantasy = ordered.reduce((sum, row) => sum + numeric(row.fantasy_points_ppr), 0);
    const carries = ordered.reduce((sum, row) => sum + numeric(row.carries), 0);
    const targets = ordered.reduce((sum, row) => sum + numeric(row.targets), 0);
    const receptions = ordered.reduce((sum, row) => sum + numeric(row.receptions), 0);
    const scrimmageYards = ordered.reduce((sum, row) => sum + numeric(row.rushing_yards) + numeric(row.receiving_yards), 0);
    const touchdowns = ordered.reduce((sum, row) => sum + numeric(row.rushing_tds) + numeric(row.receiving_tds) + numeric(row.passing_tds), 0);
    const late = ordered.slice(-6);
    const weeklyFantasy = ordered.map((row) => numeric(row.fantasy_points_ppr));
    const weeklyOpportunity = ordered.map((row) => row.position === 'QB'
      ? numeric(row.attempts) + numeric(row.carries) * 2.5
      : row.position === 'K' ? numeric(row.fg_att) + numeric(row.pat_att)
        : numeric(row.carries) + numeric(row.targets));
    const ppg = fantasy / Math.max(1, games);
    const latePpg = late.reduce((sum, row) => sum + numeric(row.fantasy_points_ppr), 0) / Math.max(1, late.length);
    const position = ordered[0]?.position ?? '';
    const opportunities = weeklyOpportunity.reduce((sum, value) => sum + value, 0) / Math.max(1, games);
    const priorTeam = ordered.at(-1)?.team ?? null;
    const scheduledGames = priorTeam ? teamGames.get(priorTeam)?.size ?? 17 : 17;
    return {
      playerId, rows: ordered, current: currentRoster.get(playerId), position,
      name: ordered[0]?.player_display_name ?? '', priorTeam,
      games, fantasy, ppg, latePpg, carries, targets, receptions, scrimmageYards, touchdowns, opportunities,
      availability: Math.min(1, games / Math.max(1, scheduledGames)),
      weeklyFloor: quantile(weeklyFantasy, 0.2), weeklyCeiling: quantile(weeklyFantasy, 0.8),
      targetShare: weightedShare(ordered, 'targets', 'target_share'),
      airYardsShare: weightedShare(ordered, 'receiving_air_yards', 'air_yards_share'),
    };
  });

  const ppgByPosition = new Map<string, number[]>();
  const opportunityByPosition = new Map<string, number[]>();
  const weeklyFloorByPosition = new Map<string, number[]>();
  const weeklyCeilingByPosition = new Map<string, number[]>();
  const targetShareByPosition = new Map<string, number[]>();
  const airShareByPosition = new Map<string, number[]>();
  for (const player of aggregates.filter((candidate) => candidate.games >= 4)) {
    ppgByPosition.set(player.position, [...(ppgByPosition.get(player.position) ?? []), player.ppg]);
    opportunityByPosition.set(player.position, [...(opportunityByPosition.get(player.position) ?? []), player.opportunities]);
    weeklyFloorByPosition.set(player.position, [...(weeklyFloorByPosition.get(player.position) ?? []), player.weeklyFloor]);
    weeklyCeilingByPosition.set(player.position, [...(weeklyCeilingByPosition.get(player.position) ?? []), player.weeklyCeiling]);
    targetShareByPosition.set(player.position, [...(targetShareByPosition.get(player.position) ?? []), player.targetShare]);
    airShareByPosition.set(player.position, [...(airShareByPosition.get(player.position) ?? []), player.airYardsShare]);
  }

  const researchedAt = new Date().toISOString();
  const profiles: PlayerIntelligenceInput[] = aggregates.map((player) => {
    const trend = player.latePpg - player.ppg;
    const productionPercentile = percentile(ppgByPosition.get(player.position) ?? [], player.ppg);
    const opportunityPercentile = percentile(opportunityByPosition.get(player.position) ?? [], player.opportunities);
    const weeklyFloorPercentile = percentile(weeklyFloorByPosition.get(player.position) ?? [], player.weeklyFloor);
    const weeklyCeilingPercentile = percentile(weeklyCeilingByPosition.get(player.position) ?? [], player.weeklyCeiling);
    const targetSharePercentile = percentile(targetShareByPosition.get(player.position) ?? [], player.targetShare);
    const airSharePercentile = percentile(airShareByPosition.get(player.position) ?? [], player.airYardsShare);
    const availabilityScore = player.availability * 100;
    const rawFloor = player.position === 'QB'
      ? weeklyFloorPercentile * 0.3 + productionPercentile * 0.25 + opportunityPercentile * 0.25 + availabilityScore * 0.2
      : player.position === 'RB'
        ? opportunityPercentile * 0.35 + targetSharePercentile * 0.2 + weeklyFloorPercentile * 0.25 + availabilityScore * 0.2
        : player.position === 'WR' || player.position === 'TE'
          ? targetSharePercentile * 0.3 + airSharePercentile * 0.15 + weeklyFloorPercentile * 0.25 + opportunityPercentile * 0.1 + availabilityScore * 0.2
          : weeklyFloorPercentile * 0.3 + opportunityPercentile * 0.3 + availabilityScore * 0.4;
    const rawCeiling = player.position === 'QB'
      ? weeklyCeilingPercentile * 0.35 + productionPercentile * 0.25 + opportunityPercentile * 0.3 + Math.max(0, trend) * 1.5
      : player.position === 'RB'
        ? weeklyCeilingPercentile * 0.3 + opportunityPercentile * 0.3 + targetSharePercentile * 0.2 + productionPercentile * 0.15 + Math.max(0, trend)
        : player.position === 'WR' || player.position === 'TE'
          ? weeklyCeilingPercentile * 0.3 + targetSharePercentile * 0.25 + airSharePercentile * 0.15 + productionPercentile * 0.2 + Math.max(0, trend)
          : weeklyCeilingPercentile * 0.35 + productionPercentile * 0.25 + opportunityPercentile * 0.2 + 10;
    const rosterStatus = player.current?.status_description_abbr || player.current?.status || null;
    const currentTeam = player.current?.team || null;
    const changedTeams = !!currentTeam && currentTeam !== player.priorTeam;
    const transferPenalty = changedTeams ? 0.82 : 1;
    const floor = round(Math.max(1, Math.min(99, shrink(rawFloor, player.games) * transferPenalty)));
    const ceiling = round(Math.max(floor, Math.min(99, 50 + (shrink(rawCeiling, player.games) - 50) * transferPenalty)));
    const role = describeRole(player.position, player.opportunities, player.targetShare, player.ppg, trend);
    const evidence = [
      { source: STATS_SOURCE, kind: 'weekly-statistics', claim: `2025 regular-season production and late-season split across ${player.games} games.` },
      { source: ROSTER_SOURCE, kind: 'current-roster', claim: currentTeam ? `2026 roster lists ${currentTeam} and status ${rosterStatus ?? 'unknown'}.` : 'No 2026 roster match; current role requires confirmation.' },
      { source: POSITION_RESEARCH[player.position] ?? POSITION_RESEARCH.K, kind: 'position-methodology', claim: 'Position-specific floor and ceiling interpretation, not a copied ranking.' },
    ];
    return {
      name: player.name, nflverseId: player.playerId, profileVersion: 'usage-context-v2', sampleSeason: 2025,
      games: player.games, age: player.current?.birth_date ? ageOn(player.current.birth_date, 2026) : null,
      rosterStatus, priorTeam: player.priorTeam, currentTeam,
      fantasyPointsPpr: round(player.fantasy), fantasyPpgPpr: round(player.ppg), lateSeasonPpgPpr: round(player.latePpg),
      carries: player.carries, targets: player.targets, receptions: player.receptions,
      scrimmageYards: player.scrimmageYards, totalTouchdowns: player.touchdowns,
      opportunitiesPerGame: round(player.opportunities), targetShare: round(player.targetShare * 100),
      airYardsShare: round(player.airYardsShare * 100), trendScore: round(trend), floorScore: floor, ceilingScore: ceiling,
      roleSummary: role,
      floorCase: `Floor blends a ${round(player.weeklyFloor)}-point weekly P20, ${round(player.opportunities)} weighted opportunities per active game, and ${round(player.availability * 100)}% appearance rate.`,
      ceilingCase: trend > 1
        ? `Late-season output rose ${round(trend)} PPR points per game above the full-season pace; sustained role quality is the ceiling path.`
        : `Ceiling requires either more volume or better touchdown efficiency than the 2025 weekly baseline.`,
      riskNote: currentTeam && currentTeam !== player.priorTeam
        ? `Team changed from ${player.priorTeam ?? 'unknown'} to ${currentTeam}; prior usage is less transferable.`
        : rosterStatus && rosterStatus !== 'A01' && rosterStatus !== 'ACT'
          ? `Current roster status is ${rosterStatus}; verify before relying on the projection.`
          : `Role competition and 2026 scheme changes are not captured by the 2025 box-score sample.`,
      evidence, sourceCount: evidence.length, dataQuality: player.games >= 12 && currentTeam && !changedTeams ? 'strong' : player.games >= 4 ? 'partial' : 'context-only', researchedAt,
    };
  });

  const playersWithStats = new Set(aggregates.map((player) => player.playerId));
  for (const player of rosters) {
    if (playersWithStats.has(player.gsis_id) || !['QB', 'RB', 'WR', 'TE', 'K'].includes(player.position)) continue;
    const source = POSITION_RESEARCH[player.position] ?? POSITION_RESEARCH.K;
    const draftNumber = numeric(player.draft_number);
    const isRookie = numeric(player.years_exp) === 0 || numeric(player.entry_year) >= 2026;
    const capitalScore = !isRookie ? 42 : draftNumber > 0 && draftNumber <= 32 ? 78 : draftNumber <= 64 ? 70 : draftNumber <= 100 ? 62 : draftNumber <= 160 ? 54 : 46;
    const floorScore = Math.max(20, capitalScore - (isRookie ? 24 : 12));
    const ceilingScore = Math.min(92, capitalScore + (isRookie ? 18 : 12));
    profiles.push({
      name: player.full_name, nflverseId: player.gsis_id, profileVersion: 'roster-context-v2', sampleSeason: 2025,
      games: 0, age: player.birth_date ? ageOn(player.birth_date, 2026) : null,
      rosterStatus: player.status_description_abbr || player.status || null, priorTeam: null, currentTeam: player.team || null,
      fantasyPointsPpr: null, fantasyPpgPpr: null, lateSeasonPpgPpr: null, carries: null, targets: null,
      receptions: null, scrimmageYards: null, totalTouchdowns: null, opportunitiesPerGame: null,
      targetShare: null, airYardsShare: null, trendScore: null, floorScore, ceilingScore,
      roleSummary: `Current 2026 ${player.team} roster context; ${isRookie ? `rookie prior uses NFL draft pick ${draftNumber || 'undrafted'}` : 'no 2025 regular-season usage sample is available'}.`,
      floorCase: isRookie ? 'The rookie floor is discounted for uncertain year-one playing time and role retention.' : 'The floor is unresolved until a current weekly opportunity baseline is observed.',
      ceilingCase: isRookie ? 'Ceiling is differentiated by NFL investment, then remains capped until current role evidence arrives.' : 'Ceiling depends on earning a meaningful role within the current 2026 depth chart.',
      riskNote: 'Treat preseason role evidence as more important than a projection derived from zero NFL games.',
      evidence: [
        { source: ROSTER_SOURCE, kind: 'current-roster', claim: `2026 roster lists ${player.team} and status ${player.status_description_abbr || player.status || 'unknown'}.` },
        { source, kind: 'position-methodology', claim: 'Position-specific role and ceiling framework; no prior-season production was imputed.' },
      ], sourceCount: 2, dataQuality: 'context-only', researchedAt,
    });
  }

  for (const unit of DST_CONTEXT) {
    const floorScore = Math.max(35, 94 - unit.rank * 4);
    profiles.push({
      name: unit.name, nflverseId: `team-${unit.team}`, profileVersion: 'dst-context-v1', sampleSeason: 2025,
      games: 17, age: null, rosterStatus: 'TEAM', priorTeam: unit.team, currentTeam: unit.team,
      fantasyPointsPpr: null, fantasyPpgPpr: null, lateSeasonPpgPpr: null, carries: null, targets: null,
      receptions: null, scrimmageYards: null, totalTouchdowns: null, opportunitiesPerGame: null,
      targetShare: null, airYardsShare: null, trendScore: null, floorScore, ceilingScore: Math.min(99, floorScore + 12),
      roleSummary: unit.role, floorCase: `Current evidence supports a 2026 D/ST${unit.rank} starting point, with matchup streaming still preferred.`,
      ceilingCase: 'Ceiling comes from sustained pressure plus favorable early-season opponents creating sack and turnover chances.',
      riskNote: unit.risk,
      evidence: [
        { source: POSITION_RESEARCH.DST, kind: 'defense-context', claim: `2026 unit analysis and rank ${unit.rank}, including pressure, efficiency, personnel, and schedule context.` },
        { source: ROSTER_SOURCE, kind: 'current-roster', claim: `Current 2026 player-roster dataset used as the personnel baseline for ${unit.team}.` },
      ], sourceCount: 2, dataQuality: 'context-only', researchedAt,
    });
  }

  return {
    checksum: createHash('sha256').update(statsBytes).update(rosterBytes).digest('hex'),
    profiles,
  };
}
