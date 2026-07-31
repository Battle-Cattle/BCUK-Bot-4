import tmi from 'tmi.js';
import { TWITCH_USERNAME, TWITCH_OAUTH_TOKEN } from '../shared/config';
import { handleCommand } from '../commands/commandRouter';
import { executeCustomCommandForTwitch } from '../commands/customCommandHandler';
import { executeCounterCommandForTwitch } from '../commands/counterHandler';
import { executeMultiCommandForTwitch } from '../commands/multiCommandHandler';
import { executeShoutoutForTwitch } from '../commands/shoutoutHandler';
import { executeCountdownForTwitch } from '../commands/countdownHandler';
import { fireAndForget } from '../commands/commandUtils';
import { recordChatMessage } from './twitchChatActivity';
import { setTwitchChannel } from '../shared/statusStore';
import { normalizeTwitchChannelName } from './twitchChannelName';
import { throttledTwitchSend } from './twitchSendQueue';
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

/**
 * tmi.js `message` event handler: records the message for timer commands'
 * `min_messages` gate (see `twitchChatActivity.ts`), then dispatches it to
 * every command handler (custom commands, counters, `!multi`, `!so`, the shared
 * command router, countdowns) in parallel via {@link fireAndForget}. Ignores the
 * bot's own messages, messages from channels not in the active set, and messages
 * shared into this channel from a partner channel in a Twitch shared-chat session
 * (so each message is only recorded/handled once, in its source channel).
 * @param channel - Twitch channel the message was received in (as `#channel`).
 * @param tags - tmi.js chat user state (badges, mod status, display name, etc.) for the sender.
 * @param message - Raw chat message text.
 * @param self - Whether this message was sent by the bot's own account.
 */
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

    recordChatMessage(normalizedChannel);

    const displayName = tags['display-name'] ?? tags.username ?? null;
    const isMod = tags.mod === true || !!(tags.badges as Record<string, string> | null | undefined)?.broadcaster;

    fireAndForget(executeCustomCommandForTwitch(normalizedChannel, message, displayName), 'Custom command error', log);
    fireAndForget(executeCounterCommandForTwitch(normalizedChannel, message, displayName), 'Counter command error', log);
    fireAndForget(executeMultiCommandForTwitch(normalizedChannel, message, displayName), 'Multi command error', log);
    fireAndForget(executeShoutoutForTwitch(normalizedChannel, message, displayName, isMod), 'Shoutout error', log);
    fireAndForget(
      resolveGuildIdForTwitchCommand(normalizedChannel).then((guildId) => handleCommand(message, 'twitch', guildId)),
      'Command handler error',
      log,
    );
    fireAndForget(executeCountdownForTwitch(normalizedChannel, message), 'Countdown error', log);
  } catch (err) {
    log.error('Unexpected error in message handler:', err);
  }
}

/**
 * tmi.js `connected` event handler: marks the bot connected, logs the active
 * channel list, pessimistically resets every active channel's status to
 * disconnected, then kicks off an async reconciliation of actually-joined
 * channels via {@link reconcileJoinedChannels}.
 * @param addr - Address of the Twitch IRC server connected to.
 * @param port - Port of the Twitch IRC server connected to.
 */
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

/**
 * tmi.js `disconnected` event handler: marks the bot disconnected, clears
 * tmi.js's internal joined-channel list (which it doesn't reset on disconnect,
 * to avoid double-joining every channel on reconnect), and marks every active
 * channel's status as disconnected.
 * @param reason - Reason string reported by tmi.js for the disconnect.
 */
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

/**
 * Starts the Twitch bot: initializes the active-channel set, creates and
 * configures the tmi.js client (identity, logging, auto-reconnect), wires up
 * message/connected/disconnected handlers, and connects.
 * @returns Resolves once the client has connected; rejects if the connection attempt fails.
 */
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

/**
 * Shape of the subset of tmi.js's internal client state this file reaches into — not part of
 * its public type surface (same tradeoff as the `channels` cast in {@link onDisconnected}), but
 * narrowed to just what's read here rather than casting through `any`.
 */
interface TmiClientInternal {
  userstate?: Record<string, { badges?: Record<string, string> | null } | undefined>;
}

/**
 * Resolves whether the bot currently holds moderator/VIP/broadcaster status in `channel`, from
 * tmi.js's internal per-channel `userstate` (populated from the IRC USERSTATE tags sent on join
 * and on every send — the same source `client.isMod()` reads, but `isMod()` only reflects the
 * `user-type` tag, which is never set for VIP or broadcaster status). `userstate` is keyed by the
 * IRC channel form (`#channel`, via tmi.js's internal `_.channel()`), not the bare name
 * {@link normalizeTwitchChannelName} returns, so the `#` has to be added back here.
 * Under-detecting privilege here only makes a send unnecessarily conservative (throttled at the
 * stricter non-privileged rate) rather than unsafe, so a missing/malformed userstate entry — e.g.
 * before the bot has joined `channel` — safely resolves to false.
 * @param channel - Normalized Twitch channel name (without a leading `#`).
 * @returns True if `channel`'s userstate badges show moderator, VIP, or broadcaster status.
 */
function isPrivilegedInChannel(channel: string): boolean {
  const badges = (client as TmiClientInternal | null)?.userstate?.[`#${channel}`]?.badges;
  return !!badges?.moderator || !!badges?.vip || !!badges?.broadcaster;
}

/**
 * Sends `message` to a Twitch channel via the connected tmi.js client, throttled against
 * Twitch's global per-account rate-limit buckets (see {@link throttledTwitchSend}) so this
 * shared entry point — used by every auto-posting feature (custom commands, counters, timers,
 * shoutouts, EventSub, etc.) — can never burst past them, regardless of how many features fire
 * at once or which channels they target. Whether the bot is currently privileged
 * (moderator/VIP/broadcaster) in the target channel is re-checked live (see
 * {@link isPrivilegedInChannel}) right before the send actually runs, not when it's queued, since
 * this call may sit behind others for a while — the same reason the connection itself is
 * rechecked below rather than trusted from before queueing.
 * @param channel - Twitch channel to send to (normalized before sending).
 * @param message - Message text to send.
 * @returns Resolves once the message has actually been sent.
 * @throws If `channel` doesn't normalize to a valid channel name, or the client isn't connected
 *   (checked both before queueing and again when the send actually runs, since the connection
 *   can drop while this send is waiting behind others in the global queue).
 */
export async function sayInChannel(channel: string, message: string): Promise<void> {
  const normalized = normalizeTwitchChannelName(channel);
  if (!normalized) throw new Error(`[Twitch] Invalid channel name: ${channel}`);
  if (!client || !connected) throw new Error(`[Twitch] Cannot send message — not connected`);
  await throttledTwitchSend(normalized, () => isPrivilegedInChannel(normalized), async () => {
    if (!client || !connected) throw new Error(`[Twitch] Cannot send message — not connected`);
    await client.say(normalized, message);
  });
}

/**
 * Stops the Twitch bot: disconnects the tmi.js client (marking channels
 * disconnected if the disconnect itself fails), tears down the client
 * reference, and clears channel-membership state.
 * @returns Resolves once shutdown is complete.
 */
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
