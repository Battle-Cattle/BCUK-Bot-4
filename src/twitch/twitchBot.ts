import { ChatClient, type ChatMessage, UserState } from '@twurple/chat';
import { StaticAuthProvider } from '@twurple/auth';
import { TWITCH_OAUTH_TOKEN, TWITCH_CLIENT_ID } from '../shared/config';
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
import { throttledTwitchSend, withTimeout } from './twitchSendQueue';
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

let client: ChatClient | null = null;
let connected = false;

/**
 * Upper bound on how long {@link stopTwitchBot} waits for the `onDisconnect` event to fire after
 * calling `client.quit()`. `quit()` itself doesn't return a promise — bounding the wait here
 * guarantees shutdown always proceeds instead of hanging indefinitely if the event never arrives.
 */
const DISCONNECT_TIMEOUT_MS = 5_000;

/**
 * Per-channel badge status (moderator/VIP/broadcaster) for the bot's own account, refreshed from
 * the raw IRC `USERSTATE` message Twitch sends after joining a channel and after every send in it
 * (see {@link onOwnUserState}) — Twurple's `ChatClient` has no higher-level "am I currently
 * privileged here" query. Missing until the bot has received a `USERSTATE` for a channel — e.g.
 * right after joining — which safely defaults {@link isPrivilegedInChannel} to the more
 * conservative non-privileged rate.
 */
const privilegedChannels = new Set<string>();

/** Test-only: clears {@link privilegedChannels} so each test starts from a clean slate. */
export function __resetTwitchPrivilegedChannelsForTests(): void {
  privilegedChannels.clear();
}

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
 * Parses a raw IRC `badges` tag value (e.g. `"moderator/1,subscriber/12"`) into a set of badge names.
 * @param rawBadges - The raw `badges` tag value, or `undefined` if the tag was absent.
 * @returns The badge names present (e.g. `{'moderator', 'subscriber'}`), or an empty set if `rawBadges` was `undefined`.
 */
function parseBadgeNames(rawBadges: string | undefined): Set<string> {
  if (!rawBadges) return new Set();
  return new Set(rawBadges.split(',').map((entry) => entry.split('/')[0]));
}

/**
 * Records the bot's own moderator/VIP/broadcaster badge status for `channel` in
 * {@link privilegedChannels}, so {@link isPrivilegedInChannel} can answer live without a per-send
 * API call.
 * @param channel - Normalized Twitch channel name the badges were observed in.
 * @param badgeNames - Badge names parsed from the `USERSTATE`'s `badges` tag (see {@link parseBadgeNames}).
 * @returns Nothing — mutates {@link privilegedChannels} in place.
 */
function updateOwnPrivilegeStatus(channel: string, badgeNames: Set<string>): void {
  const privileged = badgeNames.has('moderator') || badgeNames.has('vip') || badgeNames.has('broadcaster');
  if (privileged) privilegedChannels.add(channel);
  else privilegedChannels.delete(channel);
}

/**
 * Raw IRC `USERSTATE` handler, registered directly on the underlying `ircv3` client (see
 * {@link startTwitchBot}) since Twurple's `ChatClient` doesn't expose this event itself. Twitch
 * sends `USERSTATE` after the bot joins a channel and after every message it sends there, carrying
 * the bot's own current badges in that channel — the only reliable live source for this, since
 * Twitch does not echo the bot's own `PRIVMSG`s back through `onMessage`.
 * @param msg - The raw `USERSTATE` message, including the channel (`#channel`) and IRC tags.
 * @returns Nothing — updates {@link privilegedChannels} via {@link updateOwnPrivilegeStatus}.
 */
function onOwnUserState(msg: UserState): void {
  const normalizedChannel = normalizeTwitchChannelName(msg.channel);
  if (!normalizedChannel) return;
  updateOwnPrivilegeStatus(normalizedChannel, parseBadgeNames(msg.tags.get('badges')));
}

/**
 * Resolves whether the bot currently holds moderator/VIP/broadcaster status in `channel`, from
 * {@link privilegedChannels} (see {@link updateOwnPrivilegeStatus} for how it's populated).
 * Under-detecting privilege here only makes a send unnecessarily conservative (throttled at the
 * stricter non-privileged rate) rather than unsafe, so a channel the bot hasn't been observed
 * chatting in yet — e.g. right after joining — safely resolves to false.
 * @param channel - Normalized Twitch channel name (without a leading `#`).
 * @returns True if the bot's last-observed status in `channel` was moderator, VIP, or broadcaster.
 */
function isPrivilegedInChannel(channel: string): boolean {
  return privilegedChannels.has(channel);
}

/**
 * Twurple `onMessage` event handler: records the message for timer commands'
 * `min_messages` gate (see `twitchChatActivity.ts`), then dispatches it to
 * every command handler (custom commands, counters, `!multi`, `!so`, the shared
 * command router, countdowns) in parallel via {@link fireAndForget}. Ignores
 * messages from channels not in the active set, and messages shared into this
 * channel from a partner channel in a Twitch shared-chat session (so each
 * message is only recorded/handled once, in its source channel). Never fires
 * for the bot's own sent messages — Twitch doesn't echo them back over IRC —
 * so there's no self-message case to filter here (see {@link onOwnUserState}
 * for how the bot's own privilege status is tracked instead).
 * @param channel - Twitch channel the message was received in (as `#channel`).
 * @param user - Login name of the message's sender.
 * @param message - Raw chat message text.
 * @param msg - Full Twurple chat message, including sender badges/mod status and shared-chat info.
 */
function handleTwitchMessage(channel: string, user: string, message: string, msg: ChatMessage): void {
  try {
    const normalizedChannel = normalizeTwitchChannelName(channel);
    if (!normalizedChannel) return;

    if (!getActiveChannels().has(normalizedChannel)) return;

    // In Twitch shared chat, sourceChannelId differs from channelId when a message
    // originated in a partner channel and was shared into this one. Skip it entirely
    // (including SFX command handling) so each message is only processed once, in
    // its source channel.
    if (msg.sourceChannelId && msg.sourceChannelId !== msg.channelId) return;

    recordChatMessage(normalizedChannel);

    const displayName = msg.userInfo.displayName ?? user ?? null;
    const isMod = msg.userInfo.isMod || msg.userInfo.isBroadcaster;

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
 * Twurple `onAuthenticationSuccess` event handler: marks the bot connected, logs the active
 * channel list, pessimistically resets every active channel's status to disconnected, then kicks
 * off an async reconciliation of actually-joined channels via {@link reconcileJoinedChannels}. Bound
 * to authentication succeeding rather than the raw `onConnect` (IRC socket connected, but not yet
 * authenticated) — joining channels or sending before authentication completes would fail.
 */
function onConnected(): void {
  connected = true;
  setConnected(true);
  log.info('Connected to Twitch chat.');
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
 * Twurple `onDisconnect` event handler: marks the bot disconnected, marks every active channel's
 * status as disconnected, and clears {@link privilegedChannels}. Unlike tmi.js, Twurple's
 * underlying IRC client resets its own joined-channel list on every (re)connect, so there's no
 * equivalent of tmi.js's manual internal-state reset to avoid double-joining on reconnect. Clearing
 * privilege state matters because Twurple reconnects within the same `ChatClient` instance (this
 * handler doesn't imply a new client, unlike {@link stopTwitchBot}) — without this, a channel that
 * revoked the bot's mod/VIP status while disconnected would keep the stale privileged rate-limit
 * ceiling until its next `USERSTATE`, rather than reverting to the conservative default immediately.
 * @param manually - Whether the disconnect was requested by this process (e.g. via {@link stopTwitchBot}).
 * @param reason - The error that caused the disconnect, if any.
 */
function onDisconnected(manually: boolean, reason?: Error): void {
  connected = false;
  setConnected(false);
  log.warn(`Disconnected${manually ? ' (manual)' : ''}: ${reason?.message ?? 'no reason given'}`);
  getActiveChannels().forEach((ch) => { setTwitchChannel(ch, false); });
  privilegedChannels.clear();
}

/**
 * Strips tmi.js-style `oauth:` prefixes from an access token — Twurple's auth providers expect the
 * raw token.
 * @param token - The configured access token, with or without an `oauth:` prefix.
 * @returns The token without a leading `oauth:` prefix.
 */
function stripOauthPrefix(token: string): string {
  return token.startsWith('oauth:') ? token.slice('oauth:'.length) : token;
}

/**
 * Wraps `ChatClient#connect()` — which itself returns `void` and reports outcome only via events —
 * in a promise that resolves once `onAuthenticationSuccess` fires, or rejects on an authentication
 * or token fetch failure. Resolves on authentication rather than the earlier `onConnect` (raw IRC
 * socket connected, before the account is registered) — joining channels or sending messages
 * before authentication completes would fail.
 * @param c - The Twurple chat client to connect.
 * @returns Resolves once authenticated; rejects with an error describing the failure otherwise.
 */
function connectAndWait(c: ChatClient): Promise<void> {
  return new Promise((resolve, reject) => {
    // Settles the promise exactly once, however connect() turns out — resolve on success, reject
    // on either failure — then tears down all three listeners so none can fire again later.
    const authSuccessListener = c.onAuthenticationSuccess(() => { cleanup(); resolve(); });
    const authFailureListener = c.onAuthenticationFailure((text) => {
      cleanup();
      reject(new Error(`Twitch chat authentication failed: ${text}`));
    });
    const tokenFailureListener = c.onTokenFetchFailure((err) => { cleanup(); reject(err); });
    /** Unbinds all three listeners registered above, once any one of them has fired. */
    function cleanup(): void {
      authSuccessListener.unbind();
      authFailureListener.unbind();
      tokenFailureListener.unbind();
    }
    c.connect();
  });
}

/**
 * Starts the Twitch bot: initializes the active-channel set, creates and
 * configures the Twurple chat client (static auth from the bot's own OAuth
 * token, auto-reconnect), wires up message/connect/disconnect handlers, and
 * connects.
 * @returns Resolves once the client has authenticated; rejects if the connection attempt fails.
 */
export async function startTwitchBot(): Promise<void> {
  await initializeActiveChannels();

  const authProvider = new StaticAuthProvider(TWITCH_CLIENT_ID, stripOauthPrefix(TWITCH_OAUTH_TOKEN));
  client = new ChatClient({
    authProvider,
    channels: [],
  });
  setTmiClient(client);

  client.onMessage(handleTwitchMessage);
  client.onAuthenticationSuccess(onConnected);
  client.onDisconnect(onDisconnected);
  // USERSTATE isn't exposed by ChatClient itself — only via the underlying ircv3 client.
  client.irc.onTypedMessage(UserState, onOwnUserState);

  try {
    await connectAndWait(client);
  } catch (err) {
    log.error('Failed to connect:', err);
    throw err;
  }
}

/**
 * Twitch's practical chat message length limit, in characters. `sendRawChatMessage` splits longer
 * text at this boundary rather than sending it as one oversized message.
 */
const MAX_MESSAGE_LENGTH = 500;

/**
 * Splits `text` into chunks no longer than `maxLength`, breaking on the last space at or before
 * each boundary where possible so words aren't cut mid-word. Ported from Twurple's own internal
 * `ChatClient#say()` splitting logic (`splitOnSpaces` in `@twurple/chat`'s `messageUtil`), which
 * isn't exported from its public API — needed here because {@link sendRawChatMessage} bypasses
 * `ChatClient#say()` entirely (see its docs for why) and so no longer gets that splitting for free.
 * @param text - The message text to split.
 * @param maxLength - Maximum length of each returned chunk.
 * @returns One or more chunks within `maxLength`, or `[text]` unchanged if it already fits.
 */
function splitMessageOnSpaces(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const trimmed = text.trim();
  const chunks: string[] = [];
  let startIndex = 0;
  let endIndex = maxLength;
  while (startIndex < trimmed.length) {
    let spaceIndex = trimmed.lastIndexOf(' ', endIndex);
    if (spaceIndex === -1 || spaceIndex <= startIndex || trimmed.length - startIndex + 1 <= maxLength) {
      spaceIndex = startIndex + maxLength;
    }
    const chunk = trimmed.slice(startIndex, spaceIndex).trim();
    if (chunk.length) chunks.push(chunk);
    startIndex = spaceIndex + (trimmed[spaceIndex] === ' ' ? 1 : 0);
    endIndex = startIndex + maxLength;
  }
  return chunks;
}

/**
 * Sends `text` to `channel` via the underlying `ircv3` client directly, bypassing
 * `ChatClient#say()`. Twurple's `say()` runs every send through its own internal rate limiter,
 * which — unless the client is configured with a static `isAlwaysMod: true` — enforces a fixed
 * 1.2s-per-channel floor with no per-call override, regardless of the sender's actual moderator/
 * VIP/broadcaster status. That would silently re-impose a floor under exactly the privileged sends
 * {@link throttledTwitchSend} is meant to exempt from one, on top of whatever `twitchSendQueue.ts`
 * already decided — so `twitchSendQueue.ts` needs to be the only rate limiter on this path. Splits
 * `text` first (see {@link splitMessageOnSpaces}) since bypassing `say()` also bypasses its own
 * message-length splitting.
 * @param c - The connected Twurple chat client (only its underlying `irc` client is used).
 * @param channel - Normalized Twitch channel name (without a leading `#`).
 * @param text - Message text to send.
 * @returns Nothing — sends are fire-and-forget over the IRC connection, like `IrcClient#say()` itself.
 */
function sendRawChatMessage(c: ChatClient, channel: string, text: string): void {
  for (const chunk of splitMessageOnSpaces(text, MAX_MESSAGE_LENGTH)) {
    c.irc.say(`#${channel}`, chunk);
  }
}

/**
 * Sends `message` to a Twitch channel, throttled against Twitch's global per-account rate-limit
 * buckets (see {@link throttledTwitchSend}) so this shared entry point — used by every auto-posting
 * feature (custom commands, counters, timers, shoutouts, EventSub, etc.) — can never burst past
 * them, regardless of how many features fire at once or which channels they target. Whether the
 * bot is currently privileged (moderator/VIP/broadcaster) in the target channel is re-checked live
 * (see {@link isPrivilegedInChannel}) right before the send actually runs, not when it's queued,
 * since this call may sit behind others for a while — the same reason the connection itself is
 * rechecked below rather than trusted from before queueing. Sends via {@link sendRawChatMessage}
 * rather than `ChatClient#say()` directly — see its docs for why.
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
    sendRawChatMessage(client, normalized, message);
  });
}

/**
 * Calls `client.quit()` — which itself returns `void` and reports completion only via the
 * `onDisconnect` event — wrapped in a promise that resolves once that event fires.
 * @param c - The Twurple chat client to disconnect.
 * @returns Resolves once `onDisconnect` has fired.
 */
function quitAndWait(c: ChatClient): Promise<void> {
  return new Promise((resolve) => {
    const listener = c.onDisconnect(() => { listener.unbind(); resolve(); });
    c.quit();
  });
}

/**
 * Stops the Twitch bot: disconnects the Twurple chat client (marking channels
 * disconnected if the disconnect itself fails or doesn't settle within
 * {@link DISCONNECT_TIMEOUT_MS}), tears down the client reference, and
 * clears channel-membership and privilege state.
 * @returns Resolves once shutdown is complete.
 */
export async function stopTwitchBot(): Promise<void> {
  connected = false;
  setConnected(false);
  if (client) {
    try {
      await withTimeout(quitAndWait(client), DISCONNECT_TIMEOUT_MS, 'Twitch disconnect');
    } catch (err) {
      log.warn('Error during disconnect:', err);
      getActiveChannels().forEach((ch) => { setTwitchChannel(ch, false); });
    }
    client = null;
    setTmiClient(null);
  }
  clearMembershipState();
  privilegedChannels.clear();
  log.info('Disconnected.');
}
