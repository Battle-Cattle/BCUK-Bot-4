import {
  createManagedLookupCache,
  type RefreshingLookupCache,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
} from './lookupCache';
import { getAllExclusions, normalizeExcludedUsername } from './loyaltyPointsExclusions';

// ─── Cache interface ──────────────────────────────────────────────────────────

interface LoyaltyPointsExclusionLookupCache extends RefreshingLookupCache {
  byStreamerId: Map<number, Set<string>>;
}

// ─── Cache builder ────────────────────────────────────────────────────────────

/**
 * Creates an empty, already-stale exclusion lookup cache used as the initial/fallback state
 * before the first successful refresh.
 * @returns An empty `LoyaltyPointsExclusionLookupCache` with `loadedAt` set to 0.
 */
function createEmptyLoyaltyPointsExclusionLookupCache(): LoyaltyPointsExclusionLookupCache {
  return {
    // Keep the fallback cache immediately stale so a new refresh can start as soon
    // as the backoff window expires rather than waiting for the normal TTL.
    loadedAt: 0,
    byStreamerId: new Map<number, Set<string>>(),
  };
}

/**
 * Builds the exclusion lookup cache: every streamer's excluded logins, grouped by streamer id.
 * Checked on every chat message, so it's cached rather than queried per message.
 * @returns The populated `LoyaltyPointsExclusionLookupCache`.
 */
async function buildLoyaltyPointsExclusionLookupCache(): Promise<LoyaltyPointsExclusionLookupCache> {
  const byStreamerId = new Map<number, Set<string>>();
  for (const { streamerId, twitchUsername } of await getAllExclusions()) {
    const usernames = byStreamerId.get(streamerId) ?? new Set<string>();
    usernames.add(twitchUsername);
    byStreamerId.set(streamerId, usernames);
  }
  return { loadedAt: Date.now(), byStreamerId };
}

// ─── Cache state ──────────────────────────────────────────────────────────────

const loyaltyPointsExclusionLookupCache = createManagedLookupCache<LoyaltyPointsExclusionLookupCache>({
  cacheName: 'loyalty points exclusion cache',
  ttlMs: DEFAULT_CACHE_TTL_MS,
  refreshFailureBackoffMs: DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: createEmptyLoyaltyPointsExclusionLookupCache,
  loadCache: buildLoyaltyPointsExclusionLookupCache,
});

// ─── Public API ───────────────────────────────────────────────────────────────

/** Marks the exclusion lookup cache as stale so the next read triggers a refresh. */
export function invalidateLoyaltyPointsExclusionLookupCache(): void {
  loyaltyPointsExclusionLookupCache.invalidate();
}

/**
 * Checks, via the cache, whether a streamer has excluded an account from loyalty points.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The Twitch login to check (matched case-insensitively).
 * @returns True if the account is excluded on that streamer's channel.
 */
export async function isExcludedFromLoyaltyPoints(streamerId: number, twitchUsername: string): Promise<boolean> {
  const cache = await loyaltyPointsExclusionLookupCache.getCache();
  return cache.byStreamerId.get(streamerId)?.has(normalizeExcludedUsername(twitchUsername)) ?? false;
}
