import {
  createManagedLookupCache,
  type RefreshingLookupCache,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
} from './lookupCache';
import { getAllAlertConfigs, type AlertConfig, type AlertEventType } from './alertConfig';

interface AlertConfigLookupCache extends RefreshingLookupCache {
  byKey: Map<string, AlertConfig>;
}

/** Builds the cache key for one streamer/event-type pair. */
function cacheKey(streamerId: number, eventType: AlertEventType): string {
  return `${streamerId}:${eventType}`;
}

/**
 * Creates an empty, already-stale alert config lookup cache used as the initial/fallback state
 * before the first successful refresh.
 * @returns An empty `AlertConfigLookupCache` with `loadedAt` set to 0.
 */
function createEmptyAlertConfigLookupCache(): AlertConfigLookupCache {
  return {
    loadedAt: 0,
    byKey: new Map<string, AlertConfig>(),
  };
}

/**
 * Builds an alert config lookup cache keyed by `streamerId:eventType` from every `alert_config` row.
 * @param rows Every alert config row across all streamers.
 * @returns The populated `AlertConfigLookupCache`.
 */
function buildAlertConfigLookupCache(rows: AlertConfig[]): AlertConfigLookupCache {
  const byKey = new Map<string, AlertConfig>();
  for (const row of rows) {
    byKey.set(cacheKey(row.streamer_id, row.event_type), row);
  }
  return { loadedAt: Date.now(), byKey };
}

// ─── Cache state ──────────────────────────────────────────────────────────────

const alertConfigLookupCacheState = createManagedLookupCache<AlertConfigLookupCache>({
  cacheName: 'alert config cache',
  ttlMs: DEFAULT_CACHE_TTL_MS,
  refreshFailureBackoffMs: DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: createEmptyAlertConfigLookupCache,
  loadCache: async () => buildAlertConfigLookupCache(await getAllAlertConfigs()),
});

// ─── Public API ───────────────────────────────────────────────────────────────

/** Marks the alert config lookup cache as stale so the next read triggers a refresh. */
export function invalidateAlertConfigLookupCache(): void {
  alertConfigLookupCacheState.invalidate();
}

/**
 * Looks up a streamer's alert configuration for one event type via the cache, avoiding a live DB
 * query on every single EventSub notification. Used by `maybePushAlert` (the hot path); the
 * admin settings/test-alert routes still call `getAlertConfig` directly for always-fresh reads.
 * @param streamerId DB row ID of the owning streamer.
 * @param eventType The alert event type to look up.
 * @returns The alert config, or null if no row exists for this streamer/event type.
 */
export async function findCachedAlertConfig(streamerId: number, eventType: AlertEventType): Promise<AlertConfig | null> {
  const cache = await alertConfigLookupCacheState.getCache();
  return cache.byKey.get(cacheKey(streamerId, eventType)) ?? null;
}
