import {
  createManagedLookupCache,
  type RefreshingLookupCache,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
} from './lookupCache';
import { getAllConfigs, type LoyaltyPointsConfig } from './loyaltyPoints';

// ─── Cache interface ──────────────────────────────────────────────────────────

interface LoyaltyPointsConfigLookupCache extends RefreshingLookupCache {
  byStreamerId: Map<number, LoyaltyPointsConfig>;
}

// ─── Cache builder ────────────────────────────────────────────────────────────

/**
 * Creates an empty, already-stale loyalty-points config lookup cache used as the
 * initial/fallback state before the first successful refresh.
 * @returns An empty `LoyaltyPointsConfigLookupCache` with `loadedAt` set to 0.
 */
function createEmptyLoyaltyPointsConfigLookupCache(): LoyaltyPointsConfigLookupCache {
  return {
    // Keep the fallback cache immediately stale so a new refresh can start as soon
    // as the backoff window expires rather than waiting for the normal TTL.
    loadedAt: 0,
    byStreamerId: new Map<number, LoyaltyPointsConfig>(),
  };
}

/**
 * Builds a loyalty-points config lookup cache keyed by streamer id, covering every
 * streamer with a saved configuration.
 * @returns The populated `LoyaltyPointsConfigLookupCache`.
 */
async function buildLoyaltyPointsConfigLookupCache(): Promise<LoyaltyPointsConfigLookupCache> {
  const configs = await getAllConfigs();
  const byStreamerId = new Map(configs.map(({ streamerId, config }) => [streamerId, config]));
  return { loadedAt: Date.now(), byStreamerId };
}

// ─── Cache state ──────────────────────────────────────────────────────────────

const loyaltyPointsConfigLookupCache = createManagedLookupCache<LoyaltyPointsConfigLookupCache>({
  cacheName: 'loyalty points config cache',
  ttlMs: DEFAULT_CACHE_TTL_MS,
  refreshFailureBackoffMs: DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: createEmptyLoyaltyPointsConfigLookupCache,
  loadCache: buildLoyaltyPointsConfigLookupCache,
});

// ─── Public API ───────────────────────────────────────────────────────────────

/** Marks the loyalty-points config lookup cache as stale so the next read triggers a refresh. */
export function invalidateLoyaltyPointsConfigLookupCache(): void {
  loyaltyPointsConfigLookupCache.invalidate();
}

/**
 * Looks up a streamer's loyalty-points earn-rate configuration via the cache, loading/refreshing
 * it first if needed.
 * @param streamerId - The streamer's `streamer.id`.
 * @returns The streamer's configuration, or null if they have no saved configuration (callers
 *   should fall back to the app's default constants).
 */
export async function getCachedConfig(streamerId: number): Promise<LoyaltyPointsConfig | null> {
  const cache = await loyaltyPointsConfigLookupCache.getCache();
  return cache.byStreamerId.get(streamerId) ?? null;
}
