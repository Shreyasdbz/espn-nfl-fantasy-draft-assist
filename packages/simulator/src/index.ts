import type { DraftPick, Player } from '@fda/contracts';
import { draftingSlotForPick, stableHashNumber } from '@fda/domain';

export type FaultScript = Array<
  | { atPick: number; kind: 'duplicate'; count: number }
  | { atPick: number; kind: 'drop_incremental' }
  | { atPick: number; kind: 'delay'; milliseconds: number }
  | { atPick: number; kind: 'conflicting_dom'; playerId: string }
  | { atPick: number; kind: 'disconnect'; durationMs: number }
  | { atPick: number; kind: 'restart_engine' }
>;

export function chooseSimulatedPlayer(input: {
  players: Player[];
  picks: DraftPick[];
  overallPick: number;
  teamCount: number;
  seed: number;
}): Player {
  const drafted = new Set(input.picks.map((pick) => pick.playerId));
  const available = input.players.filter((player) => !drafted.has(player.id) && !player.excluded);
  if (!available.length) throw new Error('No available players remain');
  const draftingSlot = draftingSlotForPick(input.overallPick, input.teamCount);
  const slotRoster = input.picks.filter((pick) => pick.draftingSlot === draftingSlot);
  const positionCounts = slotRoster.reduce<Record<string, number>>((counts, pick) => {
    counts[pick.position] = (counts[pick.position] ?? 0) + 1;
    return counts;
  }, {});
  return available
    .map((player) => {
      const needBonus = player.position === 'RB' || player.position === 'WR'
        ? Math.max(0, 2 - (positionCounts[player.position] ?? 0)) * 8
        : Math.max(0, 1 - (positionCounts[player.position] ?? 0)) * 5;
      const jitter = stableHashNumber(input.seed + input.overallPick, player.id) * 12;
      return { player, value: 220 - (player.adp ?? player.overallRank) + needBonus + jitter };
    })
    .sort((a, b) => b.value - a.value || a.player.overallRank - b.player.overallRank)[0]!.player;
}

