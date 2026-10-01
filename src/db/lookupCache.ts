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

/**
 * Registers `value` under `key` in `map`, unless `key` is already taken — in which case the
 * existing entry is left in place and `describeCollision` (given that existing entry) is logged
 * as a warning instead. Callers are expected to process their source rows in a fixed,
 * deterministic order (e.g. ascending id) so which entry "wins" a collision stays stable across
 * cache rebuilds.
 * @param map The map being built.
 * @param key The key to register `value` under.
 * @param value The candidate value to register.
 * @param describeCollision Builds the warning message from the entry already registered under `key`.
 */
export function registerFirstWinsWithWarning<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  describeCollision: (existing: V) => string,
): void {
  const existing = map.get(key);
  if (existing) {
    log.warn(describeCollision(existing));
    return;
  }
  map.set(key, value);
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

  /** Clears the refresh backoff so the next refresh may start immediately. */
  private resetRefreshFailureState(): void {
    this.refreshAllowedAt = 0;
    this.refreshFailureCount = 0;
  }

  /**
   * Blocks further refresh attempts until `retryDelayMs` from now.
   * @param retryDelayMs - Backoff delay before the next refresh may start.
   */
  private applyRefreshFailure(retryDelayMs: number): void {
    this.refreshAllowedAt = Date.now() + retryDelayMs;
  }

  /**
   * Logs a failed background refresh and, if nothing has loaded yet, installs an empty cache
   * so callers are served something while the retry backoff runs.
   * @param err - The refresh error.
   * @param retryDelayMs - Backoff delay before the next refresh, for the log message.
   */
  private handleRefreshFailureFallback(err: unknown, retryDelayMs: number): void {
    if (!this.cache) {
      this.cache = this.options.createEmptyCache();
      log.error(`Background ${this.options.cacheName} refresh failed; serving an empty cache and retrying after ${retryDelayMs}ms.`, err);
    } else {
      log.error(`Background ${this.options.cacheName} refresh failed; serving stale cache and retrying after ${retryDelayMs}ms.`, err);
    }
  }

  /**
   * Clears the in-flight refresh slot, but only if it still holds `promiseForFinally` — an
   * {@link invalidate} or newer refresh may already have replaced it.
   * @param promiseForFinally - The refresh promise that just settled.
   */
  private clearInFlightIfCurrent(promiseForFinally: Promise<TCache>): void {
    if (this.inFlightPromise === promiseForFinally) {
      this.inFlightPromise = null;
    }
  }

  /**
   * Installs a freshly loaded cache unless an {@link invalidate} happened since the refresh began.
   * @param requestVersion - Cache version captured when the refresh started.
   * @param rebuiltCache - The newly loaded cache.
   */
  private applyRefreshSuccess(requestVersion: number, rebuiltCache: TCache): void {
    if (requestVersion === this.version) {
      this.cache = rebuiltCache;
      this.resetRefreshFailureState();
    }
  }

  /**
   * Records a failed refresh (unless superseded by an {@link invalidate}) and applies exponential
   * backoff, capped at `refreshFailureMaxBackoffMs`.
   * @param requestVersion - Cache version captured when the refresh started.
   * @param err - The refresh error.
   */
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

  /**
   * Starts a background reload if none is in flight and the backoff window has passed.
   * @param now - Current time in epoch ms.
   * @returns The in-flight refresh promise (new or existing), or null if backoff blocks a new one
   *   and none is running.
   */
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
        .catch((err: unknown) => this.applyRefreshError(requestVersion, err))
        .finally(() => {
          this.clearInFlightIfCurrent(promiseForFinally);
        });
    }

    return this.inFlightPromise;
  }

  /**
   * Awaits a refresh, falling back to the current (possibly stale) cache if it rejects.
   * @param promise - The refresh promise to await.
   * @returns The refreshed cache, or the existing cache if the refresh failed.
   * @throws The refresh error when there is no cache to fall back to.
   */
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

  /**
   * Returns the cache, loading it on first use. A loaded cache is returned immediately even past
   * its TTL (stale-while-revalidate), with a background refresh kicked off; only a cold cache
   * makes the caller wait on the load.
   * @returns The current cache.
   */
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

  /**
   * Drops the cache and any in-flight refresh and resets backoff, so the next {@link getCache}
   * reloads from scratch. Bumps the version so a refresh already in flight can't reinstall stale data.
   */
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
