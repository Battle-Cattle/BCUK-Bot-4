import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createManagedLookupCache } from './lookupCache';
import type { RefreshingLookupCache } from './lookupCache';

interface TC extends RefreshingLookupCache {
  data: string;
}

const BASE_OPTS = {
  cacheName: 'test',
  ttlMs: 5_000,
  refreshFailureBackoffMs: 1_000,
  refreshFailureMaxBackoffMs: 60_000,
};

// Flush enough microtask levels for the background refresh side-effects to settle.
// The deepest chain is: loadCache rejection → async IIFE propagates → .catch (applyRefreshError) → .finally (clearInFlight).
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('createManagedLookupCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // ─── Scenario 1: first-load failure ────────────────────────────────────────
  // When the very first loadCache() call fails there is no stale data to fall
  // back on. The cache must serve createEmptyCache() so callers don't crash,
  // and must schedule a retry once the backoff window expires.

  describe('first-load failure fallback', () => {
    it('returns the empty-cache sentinel when the first load fails', async () => {
      const createEmptyCache = vi.fn(() => ({ loadedAt: 0, data: 'empty' } as TC));
      const loadCache = vi.fn<() => Promise<TC>>().mockRejectedValue(new Error('DB down'));

      const { getCache } = createManagedLookupCache({ ...BASE_OPTS, createEmptyCache, loadCache });

      const result = await getCache();

      expect(result).toMatchObject({ data: 'empty' });
      expect(createEmptyCache).toHaveBeenCalledOnce();
    });

    it('does not retry while within the backoff window', async () => {
      const createEmptyCache = vi.fn(() => ({ loadedAt: 0, data: 'empty' } as TC));
      const loadCache = vi.fn<() => Promise<TC>>().mockRejectedValue(new Error('fail'));

      const { getCache } = createManagedLookupCache({ ...BASE_OPTS, createEmptyCache, loadCache });

      await getCache(); // fails → empty cache, refreshAllowedAt = now + 1000

      vi.advanceTimersByTime(500); // still inside 1000 ms backoff window
      await getCache(); // loadedAt:0 is stale but canStartRefresh returns false

      expect(loadCache).toHaveBeenCalledTimes(1);
    });

    it('retries once the backoff window has elapsed', async () => {
      const createEmptyCache = vi.fn(() => ({ loadedAt: 0, data: 'empty' } as TC));
      const loadCache = vi.fn<() => Promise<TC>>()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({ loadedAt: Date.now(), data: 'loaded' });

      const { getCache } = createManagedLookupCache({ ...BASE_OPTS, createEmptyCache, loadCache });

      await getCache(); // fails → empty cache (loadedAt:0 will always appear stale)

      vi.advanceTimersByTime(1_001); // past the 1000 ms backoff
      await getCache(); // stale + past backoff → starts background refresh
      await flushMicrotasks(); // let background refresh complete

      expect(loadCache).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Scenario 2: invalidate during in-flight refresh ───────────────────────
  // If invalidate() is called while a refresh is in flight, applyRefreshSuccess
  // detects the version mismatch and discards the result. getCache() then starts
  // a new refresh with the updated version and returns that result.

  describe('invalidate during in-flight refresh', () => {
    it('discards the pre-invalidation result and fetches fresh data', async () => {
      let resolveFirst!: (v: TC) => void;
      const staleResult: TC = { loadedAt: Date.now(), data: 'stale' };
      const freshResult: TC = { loadedAt: Date.now(), data: 'fresh' };

      const createEmptyCache = vi.fn(() => ({ loadedAt: 0, data: 'empty' } as TC));
      const loadCache = vi.fn<() => Promise<TC>>()
        .mockImplementationOnce(() => new Promise<TC>(r => { resolveFirst = r; }))
        .mockResolvedValueOnce(freshResult);

      const { getCache, invalidate } = createManagedLookupCache({
        ...BASE_OPTS,
        createEmptyCache,
        loadCache,
      });

      const pending = getCache(); // cache=null → startRefresh with version=0; awaits resolveFirst

      invalidate(); // version → 1; the in-flight promise reference is cleared

      resolveFirst(staleResult); // the orphaned refresh resolves; applyRefreshSuccess sees 0 !== 1

      const result = await pending; // getCache() retries with version=1 → returns freshResult

      expect(result).toMatchObject({ data: 'fresh' });
      expect(loadCache).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Scenario 3: backoff reset after success ────────────────────────────────
  // After a successful refresh resetRefreshFailureState() sets refreshAllowedAt=0
  // and refreshFailureCount=0. The next getCache() call after TTL should
  // immediately start a background refresh with no extra delay, even if earlier
  // failures had accumulated a large backoff.

  describe('backoff reset after successful refresh', () => {
    it('clears failure state so the next stale refresh starts without extra delay', async () => {
      let callCount = 0;
      const createEmptyCache = vi.fn(() => ({ loadedAt: 0, data: 'empty' } as TC));
      const loadCache = vi.fn<() => Promise<TC>>(() => {
        callCount++;
        if (callCount <= 2) return Promise.reject(new Error(`fail ${callCount}`));
        return Promise.resolve({ loadedAt: Date.now(), data: `ok-${callCount}` });
      });

      const { getCache } = createManagedLookupCache({ ...BASE_OPTS, createEmptyCache, loadCache });

      // Call 1: fails → empty cache (loadedAt:0), backoff = 1000 ms
      await getCache();
      expect(loadCache).toHaveBeenCalledTimes(1);

      // Advance past first backoff
      vi.advanceTimersByTime(1_001);

      // Call 2: stale + past backoff → background refresh (call 2) → fails, backoff = 2000 ms
      await getCache();
      await flushMicrotasks();
      expect(loadCache).toHaveBeenCalledTimes(2);

      // Advance past second backoff (2000 ms)
      vi.advanceTimersByTime(2_001);

      // Call 3: stale + past backoff → background refresh (call 3) → succeeds, resets failure state
      // (refreshAllowedAt = 0, refreshFailureCount = 0)
      await getCache();
      await flushMicrotasks();
      expect(loadCache).toHaveBeenCalledTimes(3);

      // Advance past TTL only — no additional backoff needed since failure state was reset
      vi.advanceTimersByTime(5_001);

      // Call 4: stale + refreshAllowedAt=0 → background refresh starts immediately (call 4)
      await getCache();
      await flushMicrotasks();

      expect(loadCache).toHaveBeenCalledTimes(4);
    });
  });
});
