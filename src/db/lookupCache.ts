import { createLogger } from '../logger';

const log = createLogger('DB');

export interface RefreshingLookupCache {
  loadedAt: number;
}

export interface ManagedLookupCacheOptions<TCache extends RefreshingLookupCache> {
  cacheName: string;
  ttlMs: number;
  refreshFailureBackoffMs: number;
  refreshFailureMaxBackoffMs: number;
  createEmptyCache: () => TCache;
  loadCache: () => Promise<TCache>;
}

export interface ManagedLookupCache<TCache extends RefreshingLookupCache> {
  getCache: () => Promise<TCache>;
  invalidate: () => void;
}

/**
 * Creates a managed lookup cache with TTL, background refresh, and error resilience.
 *
 * Caching strategy (stale-while-revalidate):
 * - Returns cached data immediately when available, even if expired
 * - Triggers background refresh when cache is expired (TTL exceeded)
 * - On refresh failure: applies exponential backoff and serves stale cache if available,
 *   or empty fallback cache on first load to prevent crashes
 * - On invalidation: clears cache and version counter, forcing fresh load on next access
 *
 * Concurrency handling:
 * - Multiple concurrent getCache() calls coalesce to one in-flight refresh
 * - Version tracking ensures stale results from old refreshes don't overwrite newer data
 * - Handles invalidation during in-flight refresh correctly by checking version numbers
 */
export function createManagedLookupCache<TCache extends RefreshingLookupCache>(
  options: ManagedLookupCacheOptions<TCache>,
): ManagedLookupCache<TCache> {
  let cache: TCache | null = null;
  let inFlightPromise: Promise<TCache> | null = null;
  let version = 0;
  let refreshAllowedAt = 0;
  let refreshFailureCount = 0;

  function getRefreshBackoffMs(): number {
    const backoffMultiplier = 2 ** Math.max(0, refreshFailureCount - 1);
    return Math.min(
      options.refreshFailureBackoffMs * backoffMultiplier,
      options.refreshFailureMaxBackoffMs,
    );
  }

  function canStartRefresh(now: number): boolean {
    return !inFlightPromise && now >= refreshAllowedAt;
  }

  function resetRefreshFailureState(): void {
    refreshAllowedAt = 0;
    refreshFailureCount = 0;
  }

  function applyRefreshFailure(retryDelayMs: number): void {
    refreshAllowedAt = Date.now() + retryDelayMs;
  }

  function handleRefreshFailureFallback(err: unknown, retryDelayMs: number): void {
    if (!cache) {
      cache = options.createEmptyCache();
      log.error(`Background ${options.cacheName} refresh failed; serving an empty cache and retrying after ${retryDelayMs}ms.`, err);
    } else {
      log.error(`Background ${options.cacheName} refresh failed; serving stale cache and retrying after ${retryDelayMs}ms.`, err);
    }
  }

  function clearInFlightIfCurrent(promiseForFinally: Promise<TCache>): void {
    if (inFlightPromise === promiseForFinally) {
      inFlightPromise = null;
    }
  }

  function applyRefreshSuccess(requestVersion: number, rebuiltCache: TCache): void {
    if (requestVersion === version) {
      cache = rebuiltCache;
      resetRefreshFailureState();
    }
  }

  function applyRefreshError(requestVersion: number, err: unknown): void {
    if (requestVersion === version) {
      refreshFailureCount += 1;
      const retryDelayMs = getRefreshBackoffMs();
      applyRefreshFailure(retryDelayMs);
      handleRefreshFailureFallback(err, retryDelayMs);
    }
  }

  function startRefresh(now: number): Promise<TCache> | null {
    if (canStartRefresh(now)) {
      const requestVersion = version;
      inFlightPromise = (async () => {
        const rebuiltCache = await options.loadCache();
        applyRefreshSuccess(requestVersion, rebuiltCache);
        return rebuiltCache;
      })();

      const promiseForFinally = inFlightPromise;
      void promiseForFinally
        .catch((err) => applyRefreshError(requestVersion, err))
        .finally(() => {
          clearInFlightIfCurrent(promiseForFinally);
        });
    }

    return inFlightPromise;
  }

  async function awaitCachePromise(promise: Promise<TCache>): Promise<TCache> {
    try {
      return await promise;
    } catch (err) {
      if (cache) {
        return cache;
      }

      throw err;
    }
  }

  async function getCache(): Promise<TCache> {
    const now = Date.now();

    if (cache) {
      if (now - cache.loadedAt >= options.ttlMs && now >= refreshAllowedAt) {
        startRefresh(now);
      }
      return cache;
    }

    const requestVersion = version;
    const initialRefreshPromise = startRefresh(now);
    if (!initialRefreshPromise) {
      throw new Error(`${options.cacheName} refresh did not start`);
    }

    const resolvedCache = await awaitCachePromise(initialRefreshPromise);

    if (requestVersion === version) {
      return resolvedCache;
    }

    if (cache) {
      return cache;
    }

    const retryRefreshPromise = startRefresh(Date.now());
    if (!retryRefreshPromise) {
      throw new Error(`${options.cacheName} refresh did not start`);
    }

    return await awaitCachePromise(retryRefreshPromise);
  }

  function invalidate(): void {
    version += 1;
    cache = null;
    inFlightPromise = null;
    refreshAllowedAt = 0;
    refreshFailureCount = 0;
  }

  return {
    getCache,
    invalidate,
  };
}
