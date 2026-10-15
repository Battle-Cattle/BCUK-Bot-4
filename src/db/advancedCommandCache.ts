// Chat lookup cache for advanced commands: `${channel}::${trigger}` → which command fires there.
// It only holds routes; the handler loads the full command fresh (`getAdvancedCommand`) when one
// matches. Invalidated by `advancedCommandWrites.ts` and the Twitch-link writes in `userWrites.ts`.
import { normalizeTwitchChannelName } from '../twitch/twitchChannelName';
import {
  createManagedLookupCache,
  type RefreshingLookupCache,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
} from './lookupCache';
import { normalizeCommand } from './commandStringUtils';
import { getAllAdvancedCommandChatRoutes, type AdvancedCommandChatRoute } from './advancedCommands';

interface AdvancedCommandLookupCache extends RefreshingLookupCache {
  byChannelAndTrigger: Map<string, AdvancedCommandChatRoute>;
}

/**
 * Builds the cache key for a channel and trigger.
 * @param channelName - Twitch channel name.
 * @param triggerString - Trigger string.
 * @returns The key, or null if either normalises to nothing.
 */
function cacheKey(channelName: string, triggerString: string): string | null {
  const channel = normalizeTwitchChannelName(channelName);
  const trigger = normalizeCommand(triggerString);
  return channel && trigger ? `${channel}::${trigger}` : null;
}

/**
 * Indexes routes by channel and trigger. A channel+trigger can only belong to one command (the
 * streamer's own unique trigger), so there's no collision to resolve.
 * @param routes - Every chat route.
 * @returns The populated cache.
 */
function buildCache(routes: AdvancedCommandChatRoute[]): AdvancedCommandLookupCache {
  const byChannelAndTrigger = new Map<string, AdvancedCommandChatRoute>();
  for (const route of routes) {
    const key = cacheKey(route.twitchName, route.triggerString);
    if (key) byChannelAndTrigger.set(key, Object.freeze(route));
  }
  return { loadedAt: Date.now(), byChannelAndTrigger };
}

const advancedCommandLookupCache = createManagedLookupCache<AdvancedCommandLookupCache>({
  cacheName: 'advanced command cache',
  ttlMs: DEFAULT_CACHE_TTL_MS,
  refreshFailureBackoffMs: DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  // Already stale, so the first read refreshes straight away.
  createEmptyCache: () => ({ loadedAt: 0, byChannelAndTrigger: new Map() }),
  loadCache: async () => buildCache(await getAllAdvancedCommandChatRoutes()),
});

/** Marks the advanced command lookup cache as stale so the next read triggers a refresh. */
export function invalidateAdvancedCommandLookupCache(): void {
  advancedCommandLookupCache.invalidate();
}

/**
 * Finds the advanced command a chat trigger fires on a Twitch channel.
 * @param channelName - The channel the message was sent in.
 * @param triggerString - The message's first word, matched case-insensitively.
 * @returns The command's route, or null if none.
 */
export async function getAdvancedCommandForTwitchChannel(
  channelName: string,
  triggerString: string,
): Promise<AdvancedCommandChatRoute | null> {
  const key = cacheKey(channelName, triggerString);
  if (!key) return null;
  const cache = await advancedCommandLookupCache.getCache();
  return cache.byChannelAndTrigger.get(key) ?? null;
}
