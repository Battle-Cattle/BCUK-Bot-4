import { createLogger } from '../shared/logger';

const log = createLogger('DB');

/** Default freshness window (ms) before a cache triggers a background refresh. */
export const DEFAULT_CACHE_TTL_MS = 300_000;

/** Default backoff (ms) before retrying after a failed background refresh. */
export const DEFAULT_REFRESH_FAILURE_BACKOFF_MS = 5_000;

/** Default ceiling (ms) exponential backoff climbs to after repeated refresh failures. */
export const DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS = 60_000;

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

class CacheManager<TCache extends RefreshingLookupCache> implements ManagedLookupCache<TCache> {
  private cache: TCache | null = null;
  private inFlightPromise: Promise<TCache> | null = null;
  private version = 0;
  private refreshAllowedAt = 0;
  private refreshFailureCount = 0;

  constructor(private readonly options: ManagedLookupCacheOptions<TCache>) {}

  private resetRefreshFailureState(): void {
    this.refreshAllowedAt = 0;
    this.refreshFailureCount = 0;
  }

  private applyRefreshFailure(retryDelayMs: number): void {
    this.refreshAllowedAt = Date.now() + retryDelayMs;
  }

  private handleRefreshFailureFallback(err: unknown, retryDelayMs: number): void {
    if (!this.cache) {
      this.cache = this.options.createEmptyCache();
      log.error(`Background ${this.options.cacheName} refresh failed; serving an empty cache and retrying after ${retryDelayMs}ms.`, err);
    } else {
      log.error(`Background ${this.options.cacheName} refresh failed; serving stale cache and retrying after ${retryDelayMs}ms.`, err);
    }
  }

  private clearInFlightIfCurrent(promiseForFinally: Promise<TCache>): void {
    if (this.inFlightPromise === promiseForFinally) {
      this.inFlightPromise = null;
    }
  }

  private applyRefreshSuccess(requestVersion: number, rebuiltCache: TCache): void {
    if (requestVersion === this.version) {
      this.cache = rebuiltCache;
      this.resetRefreshFailureState();
    }
  }

  private applyRefreshError(requestVersion: number, err: unknown): void {
    if (requestVersion === this.version) {
      this.refreshFailureCount += 1;
      const backoffMultiplier = 2 ** Math.max(0, this.refreshFailureCount - 1);
      const retryDelayMs = Math.min(
        this.options.refreshFailureBackoffMs * backoffMultiplier,
        this.options.refreshFailureMaxBackoffMs,
      );
      this.applyRefreshFailure(retryDelayMs);
      this.handleRefreshFailureFallback(err, retryDelayMs);
    }
  }

  private startRefresh(now: number): Promise<TCache> | null {
    if (!this.inFlightPromise && now >= this.refreshAllowedAt) {
      const requestVersion = this.version;
      this.inFlightPromise = (async () => {
        const rebuiltCache = await this.options.loadCache();
        this.applyRefreshSuccess(requestVersion, rebuiltCache);
        return rebuiltCache;
      })();

      const promiseForFinally = this.inFlightPromise;
      void promiseForFinally
        .catch((err) => this.applyRefreshError(requestVersion, err))
        .finally(() => {
          this.clearInFlightIfCurrent(promiseForFinally);
        });
    }

    return this.inFlightPromise;
  }

  private async awaitCachePromise(promise: Promise<TCache>): Promise<TCache> {
    try {
      return await promise;
    } catch (err) {
      if (this.cache) {
        return this.cache;
      }
      throw err;
    }
  }

  async getCache(): Promise<TCache> {
    const now = Date.now();

    if (this.cache) {
      if (now - this.cache.loadedAt >= this.options.ttlMs && now >= this.refreshAllowedAt) {
        void this.startRefresh(now);
      }
      return this.cache;
    }

    const requestVersion = this.version;
    const initialRefreshPromise = this.startRefresh(now);
    if (!initialRefreshPromise) {
      throw new Error(`${this.options.cacheName} refresh did not start`);
    }

    let resolvedCache: TCache;
    try {
      resolvedCache = await this.awaitCachePromise(initialRefreshPromise);
    } catch (err) {
      if (requestVersion !== this.version) {
        const retryAfterVersionChange = this.startRefresh(Date.now());
        if (retryAfterVersionChange) {
          return this.awaitCachePromise(retryAfterVersionChange);
        }
      }
      throw err;
    }
    const postRefreshCache = requestVersion === this.version ? resolvedCache : this.cache;
    if (postRefreshCache !== null) {
      return postRefreshCache;
    }

    const retryRefreshPromise = this.startRefresh(Date.now());
    if (!retryRefreshPromise) {
      throw new Error(`${this.options.cacheName} refresh did not start`);
    }

    return this.awaitCachePromise(retryRefreshPromise);
  }

  invalidate(): void {
    this.version += 1;
    this.cache = null;
    this.inFlightPromise = null;
    this.refreshAllowedAt = 0;
    this.refreshFailureCount = 0;
  }
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
  const manager = new CacheManager(options);
  return {
    getCache: () => manager.getCache(),
    invalidate: () => manager.invalidate(),
  };
}
