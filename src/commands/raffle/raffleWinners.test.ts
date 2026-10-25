import { describe, it, expect } from 'vitest';
import { getMaxWinners, getPrizeShare, pickWinners, rollWinnerCount } from './raffleWinners';

describe('getMaxWinners', () => {
  it.each([
    [0, 0],
    [1, 1],
    [3, 1],
    [4, 2],
    [6, 2],
    [7, 3],
    [13, 5],
    [100, 5],
  ])('allows up to %d entrants → %d winners', (entrants, expected) => {
    expect(getMaxWinners(entrants)).toBe(expected);
  });
});

describe('rollWinnerCount', () => {
  it('returns 0 when nobody entered', () => {
    expect(rollWinnerCount(0, () => 0.5)).toBe(0);
  });

  it('rolls the low end of the range', () => {
    expect(rollWinnerCount(13, () => 0)).toBe(1);
  });

  it('rolls the high end of the range', () => {
    expect(rollWinnerCount(13, () => 0.9999)).toBe(5);
  });

  it('always has one winner with three or fewer entrants', () => {
    expect(rollWinnerCount(3, () => 0.9999)).toBe(1);
  });

  it('never exceeds the max even if random returns 1', () => {
    expect(rollWinnerCount(6, () => 1)).toBe(2);
  });
});

describe('pickWinners', () => {
  it('picks distinct entrants without changing the input', () => {
    const entrants = ['a', 'b', 'c', 'd', 'e'];
    const winners = pickWinners(entrants, 3, () => 0.5);
    expect(new Set(winners).size).toBe(3);
    winners.forEach((w) => expect(entrants).toContain(w));
    expect(entrants).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('follows the injected random source', () => {
    expect(pickWinners(['a', 'b', 'c'], 1, () => 0.9999)).toEqual(['c']);
    expect(pickWinners(['a', 'b', 'c'], 1, () => 0)).toEqual(['a']);
  });

  it('clamps the count to the number of entrants', () => {
    expect(pickWinners(['a'], 3)).toEqual(['a']);
    expect(pickWinners([], 2)).toEqual([]);
  });
});

describe('getPrizeShare', () => {
  it('splits evenly when it divides', () => {
    expect(getPrizeShare(1000, 2)).toBe(500);
  });

  it('rounds down and drops the remainder: 100 between 3 is 33 each', () => {
    expect(getPrizeShare(100, 3)).toBe(33);
  });

  it('returns 0 for no winners', () => {
    expect(getPrizeShare(100, 0)).toBe(0);
  });
});
