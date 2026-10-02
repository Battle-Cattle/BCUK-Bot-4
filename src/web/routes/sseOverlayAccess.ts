import type { Request } from 'express';
import { SSE_MAX_TOTAL_CONNECTIONS } from '../../shared/config';
import {
  getAllStreamersWithGroups, createManagedLookupCache,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS, DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  type RefreshingLookupCache,
} from '../../db';
import { ipKey } from '../rateLimits';

// Access controls for the SSE endpoints anyone can open without authenticating (the OBS
// browser-source overlays): a connection sub-pool with its own total and per-IP limits, and the
// known-streamer-login lookup that turns away logins nobody registered. Used by sseChannel.ts.

/**
 * A sub-pool of the process-wide cap with its own total and per-IP limits, for SSE endpoints
 * that anyone can open without authenticating (the OBS browser-source overlays). Keeps those
 * callers from consuming the slots the authenticated streams (companion, dashboard, health,
 * settings status) rely on, and stops a single IP from taking the whole sub-pool.
 */
export interface SseConnectionPool {
  /** Maximum concurrent connections across the whole pool. */
  readonly maxConnections: number;
  /** Maximum concurrent connections in the pool from any one client IP (see `ipKey`). */
  readonly maxPerIp: number;
  /** Current number of connections attached under this pool. */
  count: number;
  /** Current connection count per client IP key; entries are deleted when they reach zero. */
  readonly byIp: Map<string, number>;
}

/**
 * Creates an empty {@link SseConnectionPool}.
 * @param maxConnections - Pool-wide concurrent connection limit.
 * @param maxPerIp - Per-client-IP concurrent connection limit within the pool.
 * @returns A new pool with no connections counted.
 */
export function createSseConnectionPool(maxConnections: number, maxPerIp: number): SseConnectionPool {
  return { maxConnections, maxPerIp, count: 0, byIp: new Map() };
}

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

interface KnownStreamerLoginCache extends RefreshingLookupCache {
  logins: Set<string>;
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
    createEmptyCache: () => ({ loadedAt: 0, logins: new Set() }),
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

/**
 * Claims one slot in `pool` for the request's client IP, if both the pool-wide and per-IP limits
 * have room.
 * @param pool - The sub-pool to reserve in.
 * @param req - Express request; its client IP (see `ipKey`) keys the per-IP limit.
 * @returns The IP key the slot was counted under (pass it to {@link releasePoolSlot}), or null if
 *   a limit was already reached and nothing was reserved.
 */
export function tryReservePoolSlot(pool: SseConnectionPool, req: Request): string | null {
  const ip = ipKey(req);
  const perIp = pool.byIp.get(ip) ?? 0;
  if (pool.count >= pool.maxConnections || perIp >= pool.maxPerIp) return null;
  pool.count++;
  pool.byIp.set(ip, perIp + 1);
  return ip;
}

/**
 * Releases a slot claimed by {@link tryReservePoolSlot}, dropping the IP's entry at zero.
 * @param pool - The sub-pool the slot was reserved in.
 * @param ip - The IP key returned by {@link tryReservePoolSlot}.
 */
export function releasePoolSlot(pool: SseConnectionPool, ip: string): void {
  pool.count--;
  const remaining = (pool.byIp.get(ip) ?? 1) - 1;
  if (remaining > 0) pool.byIp.set(ip, remaining);
  else pool.byIp.delete(ip);
}
