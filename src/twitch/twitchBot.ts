import tmi from 'tmi.js';
import { TWITCH_USERNAME, TWITCH_OAUTH_TOKEN } from '../shared/config';
import { handleCommand } from '../commands/commandRouter';
import { executeCustomCommandForTwitch } from '../commands/customCommandHandler';
import { executeCounterCommandForTwitch } from '../commands/counterHandler';
import { executeMultiCommandForTwitch } from '../commands/multiCommandHandler';
import { executeShoutoutForTwitch } from '../commands/shoutoutHandler';
import { executeCountdownForTwitch } from '../commands/countdownHandler';
import { setTwitchChannel } from '../shared/statusStore';
import { normalizeTwitchChannelName } from './twitchChannelName';
import { createLogger } from '../shared/logger';
import {
  createManagedLookupCache,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  getAllTwitchLinkedUsers,
  findUserByTwitchName,
  type RefreshingLookupCache,
} from '../db';
import { resolveGuildIdForDiscordId } from '../discord/voicePresence';
import {
  setTmiClient,
  setConnected,
  clearMembershipState,
  getActiveChannels,
  reconcileJoinedChannels,
  initializeActiveChannels,
} from './twitchChannelMembership';

const log = createLogger('Twitch');

let client: tmi.Client | null = null;
let connected = false;
const TWITCH_CHAT_MESSAGE_PATTERN = /^\[#[^\]]+\] <[^>]+>: /;

// Bulk-loads every twitch_name → discord_id mapping in one query (like
// getTwitchEnabledChannels()) instead of a lazy per-channel lookup, so a
// chat message never blocks on an individual DB round trip. Bounded by a TTL
// so a relinked twitch_name is picked up within a few minutes rather than
// staying stale until the process restarts.
const CHANNEL_DISCORD_ID_CACHE_TTL_MS = 5 * 60 * 1000;

interface TwitchChannelDiscordIdCache extends RefreshingLookupCache {
  discordIdByChannel: Map<string, string>;
}

/** Returns a fresh, empty Twitch-channel → discord_id cache. */
function createEmptyTwitchChannelDiscordIdCache(): TwitchChannelDiscordIdCache {
  return { loadedAt: 0, discordIdByChannel: new Map() };
}

const twitchChannelDiscordIdLookupCache = createManagedLookupCache<TwitchChannelDiscordIdCache>({
  cacheName: 'twitch channel discord id cache',
  ttlMs: CHANNEL_DISCORD_ID_CACHE_TTL_MS,
  refreshFailureBackoffMs: DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: createEmptyTwitchChannelDiscordIdCache,
  loadCache: async () => {
    const linkedUsers = await getAllTwitchLinkedUsers();
    const discordIdByChannel = new Map(linkedUsers.map((u) => [u.twitchName, u.discordId]));
    return { loadedAt: Date.now(), discordIdByChannel };
  },
});

/**
 * Resolves the Discord ID linked to a Twitch channel's `twitch_name`, or null if unlinked.
 * A channel absent from the bulk cache falls back to a live lookup — the cache has no
 * per-key invalidation, so a channel linked since the last bulk refresh would otherwise
 * stay unresolved for up to the cache's TTL instead of working on the very next message.
 */
async function resolveDiscordIdForTwitchChannel(normalizedChannel: string): Promise<string | null> {
  const cache = await twitchChannelDiscordIdLookupCache.getCache();
  const cachedDiscordId = cache.discordIdByChannel.get(normalizedChannel);
  if (cachedDiscordId) return cachedDiscordId;
  const user = await findUserByTwitchName(normalizedChannel);
  return user?.discord_id ?? null;
}

/** Test-only: clears the Twitch-channel → discord_id cache so each test starts from a clean slate. */
export function __resetTwitchChannelDiscordIdCacheForTests(): void {
  twitchChannelDiscordIdLookupCache.invalidate();
}

/** Resolves which guild a Twitch chat command should target: the linked streamer's active voice guild. */
async function resolveGuildIdForTwitchCommand(normalizedChannel: string): Promise<string | null> {
  const discordId = await resolveDiscordIdForTwitchChannel(normalizedChannel);
  if (!discordId) return null;
  return resolveGuildIdForDiscordId(discordId);
}

function fireAndForget(promise: Promise<void>, context: string): void {
  promise.catch((err) => log.error(`${context}:`, err));
}

function handleTwitchMessage(
  channel: string,
  tags: tmi.ChatUserstate,
  message: string,
  self: boolean,
): void {
  try {
    if (self) return;
    const normalizedChannel = normalizeTwitchChannelName(channel);
    if (!normalizedChannel) return;
    if (!getActiveChannels().has(normalizedChannel)) return;

    // In Twitch shared chat, source-room-id differs from room-id when a message
    // originated in a partner channel and was shared into this one. Skip it entirely
    // (including SFX command handling) so each message is only processed once, in
    // its source channel.
    if (tags['source-room-id'] && tags['source-room-id'] !== tags['room-id']) return;

    const displayName = tags['display-name'] ?? tags.username ?? null;
    const isMod = tags.mod === true || !!(tags.badges as Record<string, string> | null | undefined)?.broadcaster;

    fireAndForget(executeCustomCommandForTwitch(normalizedChannel, message, displayName), 'Custom command error');
    fireAndForget(executeCounterCommandForTwitch(normalizedChannel, message, displayName), 'Counter command error');
    fireAndForget(executeMultiCommandForTwitch(normalizedChannel, message, displayName), 'Multi command error');
    fireAndForget(executeShoutoutForTwitch(normalizedChannel, message, displayName, isMod), 'Shoutout error');
    fireAndForget(
      resolveGuildIdForTwitchCommand(normalizedChannel).then((guildId) => handleCommand(message, 'twitch', guildId)),
      'Command handler error',
    );
    fireAndForget(executeCountdownForTwitch(normalizedChannel, message), 'Countdown error');
  } catch (err) {
    log.error('Unexpected error in message handler:', err);
  }
}

function onConnected(addr: string, port: number): void {
  connected = true;
  setConnected(true);
  log.info(`Connected to ${addr}:${port}`);
  log.info(`Listening on: ${[...getActiveChannels()].join(', ') || '(none)'}`);
  // Reset every activeChannels entry via setTwitchChannel to a pessimistic
  // disconnected state until reconcileJoinedChannels() asynchronously
  // rechecks the actual joined memberships and corrects the status.
  getActiveChannels().forEach((ch) => { setTwitchChannel(ch, false); });
  void reconcileJoinedChannels().catch((err) => {
    log.error('Failed to reconcile joined channels:', err);
  });
}

function onDisconnected(reason: string): void {
  connected = false;
  setConnected(false);
  // tmi.js ^1.8.5 does not clear its internal confirmed-channel list on
  // disconnect, so without this reset the client would re-join every channel
  // twice on reconnect (once from its own queue, once from reconcileJoinedChannels).
  // `channels` is not part of the public type surface but is a real internal array.
  (client as any).channels = [];
  log.warn(`Disconnected: ${reason}`);
  getActiveChannels().forEach((ch) => { setTwitchChannel(ch, false); });
}

export async function startTwitchBot(): Promise<void> {
  await initializeActiveChannels();

  client = new tmi.Client({
    identity: {
      username: TWITCH_USERNAME,
      password: TWITCH_OAUTH_TOKEN,
    },
    channels: [],
    options: { debug: false },
    logger: {
      info: (msg: string) => { if (!TWITCH_CHAT_MESSAGE_PATTERN.test(msg)) log.info(msg); },
      warn: (msg: string) => log.warn(msg),
      error: (msg: string) => log.error(msg),
    },
    connection: {
      reconnect: true,
      secure: true,
    },
  });
  setTmiClient(client);

  client.on('message', handleTwitchMessage);
  client.on('connected', onConnected);
  client.on('disconnected', onDisconnected);

  try {
    await client.connect();
  } catch (err) {
    log.error('Failed to connect:', err);
    throw err;
  }
}

export async function sayInChannel(channel: string, message: string): Promise<void> {
  const normalized = normalizeTwitchChannelName(channel);
  if (!normalized) throw new Error(`[Twitch] Invalid channel name: ${channel}`);
  if (!client || !connected) throw new Error(`[Twitch] Cannot send message — not connected`);
  await client.say(normalized, message);
}

export async function stopTwitchBot(): Promise<void> {
  connected = false;
  setConnected(false);
  if (client) {
    try {
      await client.disconnect();
    } catch (err) {
      log.warn('Error during disconnect:', err);
      getActiveChannels().forEach((ch) => { setTwitchChannel(ch, false); });
    }
    client = null;
    setTmiClient(null);
  }
  clearMembershipState();
  log.info('Disconnected.');
}
