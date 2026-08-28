export type DraftOrder = {
  teamCount: number;
  rounds: number;
  userSlot: number;
};

export function draftingSlotForPick(overallPick: number, teamCount: number): number {
  if (!Number.isInteger(overallPick) || overallPick < 1) throw new Error('overallPick must be positive');
  if (!Number.isInteger(teamCount) || teamCount < 2) throw new Error('teamCount must be at least 2');
  const round = Math.ceil(overallPick / teamCount);
  const offset = (overallPick - 1) % teamCount;
  return round % 2 === 1 ? offset + 1 : teamCount - offset;
}

export function pickCoordinates(overallPick: number, teamCount: number) {
  const round = Math.ceil(overallPick / teamCount);
  const offset = (overallPick - 1) % teamCount;
  return { round, pickInRound: offset + 1, draftingSlot: draftingSlotForPick(overallPick, teamCount) };
}

export function nextPickForSlot(afterOverallPick: number, teamCount: number, rounds: number, slot: number): number | null {
  const finalPick = teamCount * rounds;
  for (let pick = Math.max(1, afterOverallPick + 1); pick <= finalPick; pick += 1) {
    if (draftingSlotForPick(pick, teamCount) === slot) return pick;
  }
  return null;
}

export function normalizePlayerName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\.?\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function assertExpectedRevision(expected: number, actual: number): void {
  if (expected !== actual) {
    const error = new Error(`Expected revision ${expected}, current revision is ${actual}`);
    Object.assign(error, { code: 'REVISION_CONFLICT', statusCode: 409, currentRevision: actual });
    throw error;
  }
}

export function stableHashNumber(seed: number, key: string): number {
  let hash = seed >>> 0;
  for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash / 0xffffffff;
}

