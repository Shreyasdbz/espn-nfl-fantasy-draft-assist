import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import type { Position } from '@fda/contracts';
import type { ResearchDataset, ResearchPlayerInput } from '@fda/db';

const PLAYER_SHEET = 'Player Database';
const REQUIRED_HEADERS = [
  'Player', 'Pos', 'Team', 'Bye', 'ESPN Rank', 'Model Rank', '8-Team ADP', 'Rec. Round', 'Our Pick',
  'Phase', 'Archetype', 'Reliability', 'Ceiling', 'Opportunity', 'Role Clarity', 'Risk', 'Vision Score',
  'Model Signal', 'My Tag', 'Injury / News', 'Why He Fits', 'Failure Case', 'Alternatives',
  'Pairing / Construction', 'Earliest Pick', 'Target Pick', 'Latest Pick', 'ESPN Source', 'ADP Source',
  'Analysis Source', 'Draft Status', 'Updated',
] as const;
const POSITIONS = new Set<Position>(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);

type WorkbookRow = Record<string, unknown>;

function fail(message: string): never { throw new Error(`Research workbook is invalid: ${message}`); }
function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string') fail(`${label} must be text`);
  const result = value.trim();
  if (!allowEmpty && !result) fail(`${label} is empty`);
  return result;
}
function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be numeric`);
  return value;
}
function integer(value: unknown, label: string): number {
  const result = number(value, label);
  if (!Number.isInteger(result) || result < 1) fail(`${label} must be a positive integer`);
  return result;
}
function optionalInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  return integer(value, label);
}
function rating(value: unknown, label: string): number {
  const result = number(value, label);
  if (result < 0 || result > 10) fail(`${label} must be between 0 and 10`);
  return result;
}
function isoDate(value: unknown, label: string): string {
  const date = value instanceof Date ? value : new Date(text(value, label));
  if (Number.isNaN(date.getTime())) fail(`${label} must be a date`);
  return date.toISOString();
}
function matrixValue(rows: unknown[][], row: number, column: number, label: string): unknown {
  const value = rows[row]?.[column];
  if (value === null || value === undefined || value === '') fail(`${label} is missing`);
  return value;
}
function matchInteger(value: string, pattern: RegExp, label: string): number {
  const found = value.match(pattern)?.[1];
  if (!found) fail(`could not parse ${label}`);
  return Number(found);
}
function countPosition(starters: string, position: string): number {
  const explicit = starters.match(new RegExp(`(\\d+)\\s*${position}`, 'i'))?.[1];
  return explicit ? Number(explicit) : new RegExp(`(?:^|/)\\s*(?:1\\s*)?${position}(?:\\s|/|$)`, 'i').test(starters) ? 1 : 0;
}

export function readResearchWorkbook(filePath: string): ResearchDataset {
  const absolutePath = resolve(filePath);
  const bytes = readFileSync(absolutePath);
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: true });
  const playerSheet = workbook.Sheets[PLAYER_SHEET];
  if (!playerSheet) fail(`missing ${PLAYER_SHEET} sheet`);
  const assumptionSheet = workbook.Sheets.Assumptions;
  const hqSheet = workbook.Sheets['Draft HQ'];
  if (!assumptionSheet || !hqSheet) fail('missing Draft HQ or Assumptions sheet');

  const headerRows = XLSX.utils.sheet_to_json<unknown[]>(playerSheet, { header: 1, range: 4, raw: true, defval: null });
  const headers = new Set((headerRows[0] ?? []).filter((value): value is string => typeof value === 'string'));
  for (const header of REQUIRED_HEADERS) if (!headers.has(header)) fail(`missing ${header} column`);
  const sourceRows = XLSX.utils.sheet_to_json<WorkbookRow>(playerSheet, { range: 4, raw: true, defval: null });
  if (!sourceRows.length) fail('player table has no rows');

  const positionCounts = new Map<Position, number>();
  const names = new Set<string>();
  const players: ResearchPlayerInput[] = sourceRows
    .sort((a, b) => integer(a['Model Rank'], 'Model Rank') - integer(b['Model Rank'], 'Model Rank'))
    .map((row, index) => {
      const rowLabel = `row ${index + 6}`;
      const name = text(row.Player, `${rowLabel} Player`);
      const normalizedName = name.toLocaleLowerCase('en-US');
      if (names.has(normalizedName)) fail(`duplicate player ${name}`);
      names.add(normalizedName);
      const position = text(row.Pos, `${rowLabel} Pos`).toUpperCase() as Position;
      if (!POSITIONS.has(position)) fail(`${rowLabel} has unsupported position ${position}`);
      const positionalRank = (positionCounts.get(position) ?? 0) + 1;
      positionCounts.set(position, positionalRank);
      return {
        name, position, positionalRank,
        team: row.Team === null || row.Team === '' ? null : text(row.Team, `${rowLabel} Team`).toUpperCase(),
        byeWeek: optionalInteger(row.Bye, `${rowLabel} Bye`),
        espnRank: integer(row['ESPN Rank'], `${rowLabel} ESPN Rank`),
        modelRank: integer(row['Model Rank'], `${rowLabel} Model Rank`),
        adp: row['8-Team ADP'] === null || row['8-Team ADP'] === '' ? null : number(row['8-Team ADP'], `${rowLabel} 8-Team ADP`),
        recommendedRound: optionalInteger(row['Rec. Round'], `${rowLabel} Rec. Round`),
        plannedPick: optionalInteger(row['Our Pick'], `${rowLabel} Our Pick`),
        phase: text(row.Phase, `${rowLabel} Phase`), archetype: text(row.Archetype, `${rowLabel} Archetype`),
        reliability: rating(row.Reliability, `${rowLabel} Reliability`), ceiling: rating(row.Ceiling, `${rowLabel} Ceiling`),
        opportunity: rating(row.Opportunity, `${rowLabel} Opportunity`), roleClarity: rating(row['Role Clarity'], `${rowLabel} Role Clarity`),
        risk: rating(row.Risk, `${rowLabel} Risk`), visionScore: number(row['Vision Score'], `${rowLabel} Vision Score`),
        modelSignal: text(row['Model Signal'], `${rowLabel} Model Signal`), userTag: text(row['My Tag'], `${rowLabel} My Tag`),
        injuryNews: text(row['Injury / News'] ?? '', `${rowLabel} Injury / News`, true),
        whyFits: text(row['Why He Fits'], `${rowLabel} Why He Fits`), failureCase: text(row['Failure Case'], `${rowLabel} Failure Case`),
        alternatives: text(row.Alternatives, `${rowLabel} Alternatives`),
        pairingConstruction: text(row['Pairing / Construction'], `${rowLabel} Pairing / Construction`),
        earliestPick: optionalInteger(row['Earliest Pick'], `${rowLabel} Earliest Pick`),
        targetPick: optionalInteger(row['Target Pick'], `${rowLabel} Target Pick`),
        latestPick: optionalInteger(row['Latest Pick'], `${rowLabel} Latest Pick`),
        espnSource: text(row['ESPN Source'], `${rowLabel} ESPN Source`), adpSource: text(row['ADP Source'], `${rowLabel} ADP Source`),
        analysisSource: text(row['Analysis Source'], `${rowLabel} Analysis Source`),
        importedDraftStatus: text(row['Draft Status'], `${rowLabel} Draft Status`),
        updatedAt: isoDate(row.Updated, `${rowLabel} Updated`),
      };
    });

  const assumptions = XLSX.utils.sheet_to_json<unknown[]>(assumptionSheet, { header: 1, raw: true, defval: null });
  const hq = XLSX.utils.sheet_to_json<unknown[]>(hqSheet, { header: 1, raw: true, defval: null });
  const format = text(matrixValue(assumptions, 5, 1, 'Format'), 'Format');
  const hqFormat = text(matrixValue(hq, 9, 1, 'Draft HQ format'), 'Draft HQ format');
  const starters = text(matrixValue(assumptions, 6, 1, 'Starters'), 'Starters');
  const bench = text(matrixValue(assumptions, 7, 1, 'Bench'), 'Bench');
  const roster = {
    QB: countPosition(starters, 'QB'), RB: countPosition(starters, 'RB'), WR: countPosition(starters, 'WR'),
    TE: countPosition(starters, 'TE'), FLEX: countPosition(starters, 'FLEX'),
    DST: /D\/ST/i.test(starters) ? 1 : 0, K: countPosition(starters, 'K'),
    BENCH: matchInteger(bench, /(\d+)\s*bench/i, 'bench count'),
  };
  return {
    checksum: createHash('sha256').update(bytes).digest('hex'), sourceFilename: basename(absolutePath), sourcePath: absolutePath,
    leagueName: text(matrixValue(assumptions, 3, 1, 'League'), 'League'),
    teamName: text(matrixValue(assumptions, 4, 1, 'Team'), 'Team'),
    teamCount: matchInteger(format, /(\d+)-team/i, 'team count'),
    rounds: matchInteger(hqFormat, /(\d+)\s*rounds/i, 'round count'),
    userSlot: matchInteger(format, /pick\s+(\d+)/i, 'draft slot'),
    scoring: text(matrixValue(assumptions, 9, 1, 'Scoring assumption'), 'Scoring assumption'),
    thesis: text(matrixValue(assumptions, 10, 1, 'Primary thesis'), 'Primary thesis'),
    updatedAt: isoDate(matrixValue(assumptions, 11, 1, 'Last updated'), 'Last updated'),
    roster, players,
  };
}
