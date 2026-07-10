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
import { findUserByTwitchName } from '../db';
import { getDiscordClient } from '../discord/discordBot';
import { getActiveGuildForUser } from '../discord/voicePresence';
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

// Caches only successful Twitch-channel → discord_id resolutions (never a
// miss) so a not-yet-linked channel keeps retrying instead of being stuck
// unresolved until a restart, while a linked channel avoids a DB round trip
// on every chat message.
const twitchChannelDiscordIdCache = new Map<string, string>();

/** Resolves the Discord ID linked to a Twitch channel's `twitch_name`, or null if unlinked. */
async function resolveDiscordIdForTwitchChannel(normalizedChannel: string): Promise<string | null> {
  const cached = twitchChannelDiscordIdCache.get(normalizedChannel);
  if (cached) return cached;
  const user = await findUserByTwitchName(normalizedChannel);
  if (user) twitchChannelDiscordIdCache.set(normalizedChannel, user.discord_id);
  return user?.discord_id ?? null;
}

/** Test-only: clears the Twitch-channel → discord_id cache so each test starts from a clean slate. */
export function __resetTwitchChannelDiscordIdCacheForTests(): void {
  twitchChannelDiscordIdCache.clear();
}

/** Resolves which guild a Twitch chat command should target: the linked streamer's active voice guild. */
async function resolveGuildIdForTwitchCommand(normalizedChannel: string): Promise<string | null> {
  const discordId = await resolveDiscordIdForTwitchChannel(normalizedChannel);
  if (!discordId) return null;
  const discordClient = getDiscordClient();
  if (!discordClient) return null;
  return getActiveGuildForUser(discordClient, discordId);
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
