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
    fireAndForget(handleCommand(message, 'twitch'), 'Command handler error');
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
  // Clear tmi.js's confirmed-channel list so it doesn't replay those
  // channels in its auto-rejoin queue on the next connect. All joining
  // is handled by reconcileJoinedChannels after 'connected' fires.
  // tmi.js doesn't expose `channels` in its public types, but it is a real
  // internal array. Clearing it prevents tmi.js from auto-rejoining stale
  // channels on the next connect — all joins are handled by reconcileJoinedChannels.
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
