import { describe, expect, it } from 'vitest';
import { draftingSlotForPick, nextPickForSlot, normalizePlayerName, pickCoordinates } from './index.ts';

describe('snake draft order', () => {
  it('reverses drafting slots on even rounds', () => {
    expect(Array.from({ length: 20 }, (_, index) => draftingSlotForPick(index + 1, 10))).toEqual([
      1,2,3,4,5,6,7,8,9,10,10,9,8,7,6,5,4,3,2,1,
    ]);
    expect(pickCoordinates(17, 10)).toEqual({ round: 2, pickInRound: 7, draftingSlot: 4 });
  });

  it('finds the next turn for a slot', () => {
    expect(nextPickForSlot(3, 10, 15, 4)).toBe(4);
    expect(nextPickForSlot(4, 10, 15, 4)).toBe(17);
  });
});

describe('identity normalization', () => {
  it('normalizes punctuation, accents, and suffixes without merging arbitrary names', () => {
    expect(normalizePlayerName('José Player Jr.')).toBe('jose player');
    expect(normalizePlayerName("D'Andre Example III")).toBe('d andre example');
  });
});

