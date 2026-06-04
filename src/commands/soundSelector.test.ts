import { describe, it, expect, vi, afterEach } from 'vitest';
import { pickWeightedRandom } from './soundSelector';
import type { WeightedFile } from './soundSelector';

afterEach(() => vi.restoreAllMocks());

describe('pickWeightedRandom', () => {
  it('throws when the list is empty', () => {
    expect(() => pickWeightedRandom([])).toThrow('No files to pick from');
  });

  it('always returns the only file when the list has one item', () => {
    const files: WeightedFile[] = [{ file: 'solo.mp3', weight: 5 }];
    for (let i = 0; i < 10; i++) {
      expect(pickWeightedRandom(files)).toBe('solo.mp3');
    }
  });

  it('selects the first file when random falls in its weight range', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // rand = 0 → first file wins
    const files: WeightedFile[] = [
      { file: 'a.mp3', weight: 1 },
      { file: 'b.mp3', weight: 1 },
    ];
    expect(pickWeightedRandom(files)).toBe('a.mp3');
  });

  it('selects the second file when random falls in its weight range', () => {
    // totalWeight = 2, rand = 0.75 * 2 = 1.5 → first file subtracts 1 → remaining 0.5 > 0
    // second file subtracts 1 → remaining -0.5 <= 0 → second file wins
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
    const files: WeightedFile[] = [
      { file: 'a.mp3', weight: 1 },
      { file: 'b.mp3', weight: 1 },
    ];
    expect(pickWeightedRandom(files)).toBe('b.mp3');
  });

  it('treats zero-weight files as weight-1', () => {
    // Both files have weight 0, treated as 1 each. totalWeight = 2.
    vi.spyOn(Math, 'random').mockReturnValue(0); // first file wins
    const files: WeightedFile[] = [
      { file: 'a.mp3', weight: 0 },
      { file: 'b.mp3', weight: 0 },
    ];
    expect(pickWeightedRandom(files)).toBe('a.mp3');
  });

  it('heavily-weighted file wins almost all draws', () => {
    const files: WeightedFile[] = [
      { file: 'rare.mp3', weight: 1 },
      { file: 'common.mp3', weight: 99 },
    ];
    const results = Array.from({ length: 100 }, () => pickWeightedRandom(files));
    const commonCount = results.filter((f) => f === 'common.mp3').length;
    expect(commonCount).toBeGreaterThan(80);
  });
});
