import { SSE_MAX_TOTAL_CONNECTIONS } from '../../shared/config';
import {
  getAllStreamersWithGroups, createManagedLookupCache,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS, DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  type RefreshingLookupCache,
} from '../../db';
import { createSseConnectionPool } from './sseConnectionPool';

// Access controls for the SSE endpoints anyone can open without authenticating (the OBS
// browser-source overlays): the shared unauthenticated sub-pool (see `sseConnectionPool.ts`) and
// the known-streamer-login lookup that turns away logins nobody registered. Used by
// sseEventsHandlers.ts.

/**
 * Sub-cap for every unauthenticated overlay SSE connection (reward-video + alerts overlays
 * combined): 40% of the process-wide cap (200 at the default 500), so the remaining slots stay
 * available to authenticated streams even when the overlay pool is full.
 */
export const UNAUTH_OVERLAY_SSE_MAX_CONNECTIONS = Math.max(1, Math.floor(SSE_MAX_TOTAL_CONNECTIONS * 0.4));

/**
 * Per-IP limit within the unauthenticated overlay pool — generous enough for one streamer's OBS
 * running several overlay/alerts browser sources (across scenes) from the same machine.
 */
export const UNAUTH_OVERLAY_SSE_MAX_PER_IP = 20;

/** The shared pool both unauthenticated overlay SSE endpoints attach under. */
export const unauthenticatedOverlayPool = createSseConnectionPool(
  UNAUTH_OVERLAY_SSE_MAX_CONNECTIONS,
  UNAUTH_OVERLAY_SSE_MAX_PER_IP,
);

/** How long the known-streamer-login set is served before a background refresh. */
const KNOWN_LOGIN_CACHE_TTL_MS = 60_000;

/** The cached set of lowercased Twitch logins belonging to registered streamers. */
export interface KnownStreamerLoginCache extends RefreshingLookupCache {
  logins: Set<string>;
}

/**
 * The cache's starting value before (or if) the first load succeeds: an empty, never-loaded set.
 * @returns An empty {@link KnownStreamerLoginCache} with `loadedAt` 0.
 */
export function createEmptyKnownLoginCache(): KnownStreamerLoginCache {
  return { loadedAt: 0, logins: new Set() };
}

type KnownStreamerLoginLookup = ReturnType<typeof createManagedLookupCache<KnownStreamerLoginCache>>;

let knownStreamerLoginCache: KnownStreamerLoginLookup | null = null;

/**
 * Lazily creates the cached set of lowercased Twitch logins belonging to registered streamers, so
 * the unauthenticated overlay SSE routes can reject unknown logins without a DB hit per connect.
 * Created on first use rather than at import so modules that only import this file don't build
 * it. Stale-while-revalidate: a just-registered streamer may be 404'd until the next refresh,
 * which the overlay's `connectSse` client recovers from on its own via its reconnect backoff.
 * @returns The shared known-streamer-login cache.
 */
function getKnownStreamerLoginCache(): KnownStreamerLoginLookup {
  knownStreamerLoginCache ??= createManagedLookupCache<KnownStreamerLoginCache>({
    cacheName: 'known streamer login cache',
    ttlMs: KNOWN_LOGIN_CACHE_TTL_MS,
    refreshFailureBackoffMs: DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
    refreshFailureMaxBackoffMs: DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
    createEmptyCache: createEmptyKnownLoginCache,
    loadCache: async () => {
      const streamers = await getAllStreamersWithGroups();
      const logins = new Set<string>();
      for (const s of streamers) if (s.twitch_name) logins.add(s.twitch_name.toLowerCase());
      return { loadedAt: Date.now(), logins };
    },
  });
  return knownStreamerLoginCache;
}

/**
 * Reports whether `login` belongs to a registered streamer (any streamer row with a linked
 * Twitch name), via a short-TTL in-memory cache.
 * @param login - Already-lowercased Twitch login.
 * @returns true if a registered streamer has this login.
 */
export async function isKnownStreamerLogin(login: string): Promise<boolean> {
  const cache = await getKnownStreamerLoginCache().getCache();
  return cache.logins.has(login);
}
