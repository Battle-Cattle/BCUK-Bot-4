import { describe, it, expect, vi } from 'vitest';
import { getOrCreate } from './mapUtils';

describe('getOrCreate', () => {
  it('creates and inserts a default value when the key is absent', () => {
    const map = new Map<string, number>();
    const makeDefault = vi.fn().mockReturnValue(42);

    const result = getOrCreate(map, 'a', makeDefault);

    expect(result).toBe(42);
    expect(map.get('a')).toBe(42);
    expect(makeDefault).toHaveBeenCalledOnce();
  });

  it('returns the existing value without calling makeDefault when the key is present', () => {
    const map = new Map<string, number>([['a', 7]]);
    const makeDefault = vi.fn().mockReturnValue(42);

    const result = getOrCreate(map, 'a', makeDefault);

    expect(result).toBe(7);
    expect(makeDefault).not.toHaveBeenCalled();
  });

  it('creates a fresh default independently for each new key', () => {
    const map = new Map<string, { count: number }>();

    const a = getOrCreate(map, 'a', () => ({ count: 0 }));
    const b = getOrCreate(map, 'b', () => ({ count: 0 }));
    a.count = 5;

    expect(a).not.toBe(b);
    expect(map.get('b')?.count).toBe(0);
  });

  it('returns the same object instance on repeated lookups of an existing key', () => {
    const map = new Map<string, { count: number }>();
    const first = getOrCreate(map, 'a', () => ({ count: 0 }));
    const second = getOrCreate(map, 'a', () => ({ count: 99 }));

    expect(second).toBe(first);
  });
});
