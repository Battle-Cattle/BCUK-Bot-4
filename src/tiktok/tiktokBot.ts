import { createLogger } from '../shared/logger';
import type TypedEmitter from 'typed-emitter';
import type {
  ClientEventMap,
  TikTokLiveConnectionState,
  WebcastEvent,
  ControlEvent,
} from 'tiktok-live-connector' with { 'resolution-mode': 'import' };
import { TIKTOK_CHANNELS, TIKTOK_SIGN_API_KEY } from '../shared/config';
import { handleCommand } from '../commands/commandRouter';
import { setTikTokChannel } from '../shared/statusStore';
import {
  createManagedLookupCache,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  findOwnerUser,
  type RefreshingLookupCache,
} from '../db';
import { getDiscordClient } from '../discord/discordBot';
import { getActiveGuildForUser } from '../discord/voicePresence';

const log = createLogger('TikTok');

// Caches only a successfully-resolved owner discord_id (never a miss) so a
// bot with no owner flagged yet keeps retrying instead of being stuck
// unresolved until a restart, while normal operation avoids a DB round trip
// on every chat message. Bounded by a TTL so a reassigned is_owner is picked
// up within a few minutes rather than staying stale until the process restarts.
const OWNER_DISCORD_ID_CACHE_TTL_MS = 5 * 60 * 1000;

interface OwnerDiscordIdCache extends RefreshingLookupCache {
  discordId: string | null;
}

/** Returns a fresh, immediately-stale "no owner resolved yet" cache entry. */
function createEmptyOwnerDiscordIdCache(): OwnerDiscordIdCache {
  return { loadedAt: 0, discordId: null };
}

const ownerDiscordIdLookupCache = createManagedLookupCache<OwnerDiscordIdCache>({
  cacheName: 'tiktok owner discord id cache',
  ttlMs: OWNER_DISCORD_ID_CACHE_TTL_MS,
  refreshFailureBackoffMs: DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: createEmptyOwnerDiscordIdCache,
  loadCache: async () => {
    const owner = await findOwnerUser();
    // Only a successful resolution is cached for the full TTL; a miss stays
    // immediately stale (loadedAt: 0) so the next lookup retries instead of
    // being stuck unresolved until the TTL expires.
    return owner ? { loadedAt: Date.now(), discordId: owner.discord_id } : createEmptyOwnerDiscordIdCache();
  },
});

/** Resolves the bot owner's Discord ID, caching a successful lookup. */
async function resolveOwnerDiscordId(): Promise<string | null> {
  const cache = await ownerDiscordIdLookupCache.getCache();
  return cache.discordId;
}

/**
 * Resolves which guild a TikTok chat command should target. TikTok channels
 * have no per-streamer Discord-identity mapping today (unlike Twitch's
 * `twitch_name`), so commands are routed to wherever the bot owner is
 * currently in a voice channel.
 */
async function resolveGuildIdForTikTokCommand(): Promise<string | null> {
  const ownerDiscordId = await resolveOwnerDiscordId();
  if (!ownerDiscordId) return null;
  const discordClient = getDiscordClient();
  if (!discordClient) return null;
  return getActiveGuildForUser(discordClient, ownerDiscordId);
}

/** Test-only: clears the cached owner discord_id so each test starts from a clean slate. */
export function __resetOwnerDiscordIdCacheForTests(): void {
  ownerDiscordIdLookupCache.invalidate();
}

// TypedEventEmitter<ClientEventMap> is the base of TikTokLiveConnection but TypeScript
// can't resolve it through the library's declaration chain; cast explicitly.
type Connection = TypedEmitter<ClientEventMap> & {
  connect(roomId?: string): Promise<TikTokLiveConnectionState>;
  disconnect(): Promise<void>;
};

interface TikTokModules {
  TikTokLiveConnection: new (username: string, options: { signApiKey?: string }) => unknown;
  WebcastEvent: typeof WebcastEvent;
  ControlEvent: typeof ControlEvent;
}

const RECONNECT_DELAY_MS = 30_000;

// Tracks the active connection object per channel to prevent duplicate connections.
const activeConnections = new Map<string, Connection>();
// Tracks all pending reconnect timers so stopTikTokBot() can cancel them.
const pendingReconnectTimers = new Set<ReturnType<typeof setTimeout>>();
let stopped = false;

function connectToChannel(username: string, modules: TikTokModules): void {
  const { TikTokLiveConnection, WebcastEvent, ControlEvent } = modules;

  const existing = activeConnections.get(username);
  if (existing) {
    existing.disconnect().catch(() => { /* already disconnected */ });
    activeConnections.delete(username);
  }

  const connection = new TikTokLiveConnection(username, {
    signApiKey: TIKTOK_SIGN_API_KEY || undefined,
  }) as unknown as Connection;
  activeConnections.set(username, connection);
  let reconnectScheduled = false;
  let permanentFailure = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect(): void {
    if (stopped || reconnectScheduled || permanentFailure) return;
    reconnectScheduled = true;
    connection.disconnect().catch(() => { /* already disconnected */ });
    // Only take ownership of the map entry and schedule a reconnect when this
    // connection is still the active one — a newer connection may have already
    // replaced it, in which case we must not clobber the map or queue a
    // redundant reconnect.
    if (activeConnections.get(username) === connection) {
      activeConnections.delete(username);
      const timer = setTimeout(() => {
        pendingReconnectTimers.delete(timer);
        if (stopped) return;
        connectToChannel(username, modules);
      }, RECONNECT_DELAY_MS);
      reconnectTimer = timer;
      pendingReconnectTimers.add(timer);
    }
  }

  connection.on(ControlEvent.CONNECTED, () => {
    log.info(`Connected to @${username}`);
    setTikTokChannel(username, true);
  });

  connection.on(WebcastEvent.CHAT, (data) => {
    resolveGuildIdForTikTokCommand()
      .then((guildId) => handleCommand(data.content, 'tiktok', guildId))
      .catch((err) => log.error(`Command handler error (${username}):`, err));
  });

  connection.on(WebcastEvent.STREAM_END, () => {
    log.info(`Stream ended for @${username}. Will retry in ${RECONNECT_DELAY_MS / 1000}s`);
    setTikTokChannel(username, false);
    scheduleReconnect();
  });

  connection.on(ControlEvent.DISCONNECTED, () => {
    log.warn(`Disconnected from @${username}. Will retry in ${RECONNECT_DELAY_MS / 1000}s`);
    setTikTokChannel(username, false);
    scheduleReconnect();
  });

  connection.on(ControlEvent.ERROR, (err: unknown) => {
    log.error(`Error on @${username}:`, err);
    // Treat errors that indicate the channel is permanently unavailable as
    // fatal so that the reconnect loop does not spin forever on a bad username
    // or a banned/suspended account.
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|does not exist|banned|suspended|unauthorized|forbidden/i.test(msg)) {
      log.error(`Permanent failure for @${username} — reconnect disabled.`);
      permanentFailure = true;
      activeConnections.delete(username);
      if (reconnectTimer) {
        pendingReconnectTimers.delete(reconnectTimer);
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }
  });

  connection
    .connect()
    .then((state) => {
      log.info(`Joined roomId ${state.roomId} for @${username}`);
    })
    .catch((err: Error) => {
      log.warn(`Could not connect to @${username} (${err.message}). Will retry in ${RECONNECT_DELAY_MS / 1000}s`);
      scheduleReconnect();
    });
}

export async function startTikTokBot(): Promise<void> {
  stopped = false;
  if (TIKTOK_CHANNELS.length === 0) {
    log.info('No TIKTOK_CHANNELS configured — TikTok listener not started.');
    return;
  }

  TIKTOK_CHANNELS.forEach((ch) => setTikTokChannel(ch, false));
  log.info(`Connecting to channels: ${TIKTOK_CHANNELS.join(', ')}`);

  // Dynamic import required because tiktok-live-connector 2.3+ is ESM-only
  const modules = await import('tiktok-live-connector') as unknown as TikTokModules;

  for (const username of TIKTOK_CHANNELS) {
    connectToChannel(username, modules);
  }
}

export function stopTikTokBot(): void {
  stopped = true;
  for (const [username, conn] of activeConnections) {
    setTikTokChannel(username, false);
    conn.disconnect().catch(() => { /* already disconnected */ });
  }
  activeConnections.clear();
  for (const timer of pendingReconnectTimers) {
    clearTimeout(timer);
  }
  pendingReconnectTimers.clear();
  log.info('Stopped.');
}
