import {
  createManagedLookupCache,
  type RefreshingLookupCache,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
} from './lookupCache';
import { getAllStreamerIds } from './streamMonitor';

// ─── Cache interface ──────────────────────────────────────────────────────────

interface StreamerIdLookupCache extends RefreshingLookupCache {
  streamerIdByDiscordId: Map<string, number>;
}

// ─── Cache builder ────────────────────────────────────────────────────────────

/**
 * Creates an empty, already-stale streamer-ID lookup cache used as the initial/fallback state
 * before the first successful refresh.
 * @returns An empty `StreamerIdLookupCache` with `loadedAt` set to 0.
 */
function createEmptyStreamerIdLookupCache(): StreamerIdLookupCache {
  return { loadedAt: 0, streamerIdByDiscordId: new Map<string, number>() };
}

/**
 * Builds the streamer-ID lookup cache: every streamer row's `id`, keyed by its (unique) Discord ID.
 * Read on every Twitch chat message for chat-earn, so it's cached rather than queried per message.
 * @returns The populated `StreamerIdLookupCache`.
 */
async function buildStreamerIdLookupCache(): Promise<StreamerIdLookupCache> {
  const streamerIdByDiscordId = new Map<string, number>();
  for (const { id, discordId } of await getAllStreamerIds()) streamerIdByDiscordId.set(discordId, id);
  return { loadedAt: Date.now(), streamerIdByDiscordId };
}

// ─── Cache state ──────────────────────────────────────────────────────────────

const streamerIdLookupCache = createManagedLookupCache<StreamerIdLookupCache>({
  cacheName: 'streamer id cache',
  ttlMs: DEFAULT_CACHE_TTL_MS,
  refreshFailureBackoffMs: DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: createEmptyStreamerIdLookupCache,
  loadCache: buildStreamerIdLookupCache,
});

// ─── Public API ───────────────────────────────────────────────────────────────

/** Marks the streamer-ID lookup cache as stale so the next read reloads it. */
export function invalidateStreamerIdLookupCache(): void {
  streamerIdLookupCache.invalidate();
}

/**
 * Looks up, via the cache, the `streamer.id` of the streamer row linked to a Discord user.
 * A miss is authoritative rather than a reason for a live lookup: every write that adds or
 * removes a streamer row goes through `streamMonitorWrites.ts`, which invalidates this cache,
 * so a just-added streamer is found on the very next read.
 * @param discordId - Discord snowflake of the user.
 * @returns The streamer row's id, or null if the user isn't a streamer.
 */
export async function findStreamerIdByDiscordId(discordId: string): Promise<number | null> {
  const cache = await streamerIdLookupCache.getCache();
  return cache.streamerIdByDiscordId.get(discordId) ?? null;
}
