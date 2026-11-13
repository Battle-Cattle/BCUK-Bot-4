import { describe, it, expect } from 'vitest';
import { pruneOlderThan, TIMESTAMP_MAP_SWEEP_THRESHOLD } from './timestampPruning';

/** A map of `count` entries `k0`…, each stamped `at`. */
function filled(count: number, at: number): Map<string, number> {
  return new Map(Array.from({ length: count }, (_v, i) => [`k${i}`, at] as const));
}

describe('pruneOlderThan (#1005)', () => {
  it('leaves a map at or below the threshold alone, however old its entries', () => {
    const map = filled(TIMESTAMP_MAP_SWEEP_THRESHOLD, 0);
    pruneOlderThan(map, 1000, 1_000_000);
    expect(map.size).toBe(TIMESTAMP_MAP_SWEEP_THRESHOLD);
  });

  it('deletes entries at least maxAgeMs old once past the threshold, and keeps newer ones', () => {
    const map = filled(TIMESTAMP_MAP_SWEEP_THRESHOLD, 0);
    map.set('recent', 9_500);
    map.set('exactly-old', 9_000);
    pruneOlderThan(map, 1000, 10_000);
    expect([...map.keys()]).toEqual(['recent']);
  });
});
