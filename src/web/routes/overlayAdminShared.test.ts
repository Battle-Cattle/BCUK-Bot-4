import { describe, it, expect } from 'vitest';

import { toStringArray } from './overlayAdminShared';

// requireStreamer and parseWeight now live in (and are tested by) shared.test.ts.

// ─── toStringArray ────────────────────────────────────────────────────────────

describe('toStringArray', () => {
  it('returns the array unchanged when given an array', () => {
    expect(toStringArray(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('wraps a string in a single-element array', () => {
    expect(toStringArray('hello')).toEqual(['hello']);
  });

  it('returns an empty array for undefined', () => {
    expect(toStringArray(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(toStringArray('')).toEqual([]);
  });

  it('preserves an empty array input', () => {
    expect(toStringArray([])).toEqual([]);
  });
});
