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

  it('never picks a zero-weight file while another file has weight', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const files: WeightedFile[] = [
      { file: 'zero.mp3', weight: 0 },
      { file: 'one.mp3', weight: 1 },
    ];
    expect(pickWeightedRandom(files)).toBe('one.mp3');
  });

  it('skips a zero-weight first file even when the random draw is exactly 0', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const files: WeightedFile[] = [
      { file: 'zero.mp3', weight: 0 },
      { file: 'one.mp3', weight: 1 },
    ];
    expect(pickWeightedRandom(files)).toBe('one.mp3');
  });

  it('picks uniformly when no file has a positive weight', () => {
    const files: WeightedFile[] = [
      { file: 'a.mp3', weight: 0 },
      { file: 'b.mp3', weight: -1 },
      { file: 'c.mp3', weight: 0 },
    ];
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(pickWeightedRandom(files)).toBe('a.mp3');
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(pickWeightedRandom(files)).toBe('b.mp3');
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    expect(pickWeightedRandom(files)).toBe('c.mp3');
  });

  it('never picks a negative-weight file', () => {
    // Counted as 0, the total is 2 and 0.4 * 2 = 0.8 lands on a.mp3. (Counted as 1, as it used
    // to be, the total is 3 and 1.2 would land on negative.mp3.)
    vi.spyOn(Math, 'random').mockReturnValue(0.4);
    const files: WeightedFile[] = [
      { file: 'a.mp3', weight: 1 },
      { file: 'negative.mp3', weight: -5 },
      { file: 'b.mp3', weight: 1 },
    ];
    expect(pickWeightedRandom(files)).toBe('a.mp3');
  });

  it('falls back to the last file when rounding leaves a remainder after every subtraction', () => {
    // total = 0.1 + 0.2 = 0.30000000000000004; subtracting 0.1 then 0.2 from it leaves ~2.8e-17 > 0.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const files: WeightedFile[] = [
      { file: 'a.mp3', weight: 0.1 },
      { file: 'b.mp3', weight: 0.2 },
    ];
    expect(pickWeightedRandom(files)).toBe('b.mp3');
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
