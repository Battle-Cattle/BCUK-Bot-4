import tmi from 'tmi.js';
import { TWITCH_USERNAME, TWITCH_OAUTH_TOKEN } from '../shared/config';
import { handleCommand } from '../commands/commandRouter';
import { executeCustomCommandForTwitch } from '../commands/customCommandHandler';
import { executeCounterCommandForTwitch } from '../commands/counterHandler';
import { executeMultiCommandForTwitch } from '../commands/multiCommandHandler';
import { executeShoutoutForTwitch } from '../commands/shoutoutHandler';
import { executeCountdownForTwitch } from '../commands/countdownHandler';
import { setTwitchChannel } from '../shared/statusStore';
import { getTwitchEnabledChannels } from '../db';
import { normalizeTwitchChannelName } from './twitchChannelName';
import { getUsers } from './twitchApi';
import { createMutationQueue } from '../shared/mutationQueue';
import { createLogger } from '../shared/logger';

const log = createLogger('Twitch');

let client: tmi.Client | null = null;
let connected = false;
const activeChannels = new Set<string>();
let _onChannelJoined: ((channel: string) => void) | null = null;

export function setChannelJoinedHook(fn: (channel: string) => void): void {
  _onChannelJoined = fn;
}
const activeChannelUserIds = new Map<string, string>();
const membershipMutationQueue = createMutationQueue();
// Twitch rate-limits JOIN to 20 per 10 s (2/s). 600 ms ≈ 1.67/s, ~83% of the ceiling.
const JOIN_THROTTLE_MS = 600;
const TWITCH_CHAT_MESSAGE_PATTERN = /^\[#[^\]]+\] <[^>]+>: /;

function normalizeChannel(channel: string): string | null {
  return normalizeTwitchChannelName(channel);
}

function isChannelJoined(channel: string): boolean {
  if (!client || !connected) return false;
  return client.getChannels().some((joinedChannel) => normalizeChannel(joinedChannel) === channel);
}

function fireAndForget(promise: Promise<void>, context: string): void {
  promise.catch((err) => log.error(`${context}:`, err));
}

async function partStaleChannel(channel: string): Promise<void> {
  if (activeChannels.has(channel)) {
    setTwitchChannel(channel, true);
    return;
  }
  if (!client || !connected || !isChannelJoined(channel)) {
    setTwitchChannel(channel, false);
    return;
  }
  await client.part(channel);
  setTwitchChannel(channel, false);
  log.info(`Parted stale channel after reconnect: ${channel}`);
}

async function joinMissingChannel(channel: string): Promise<void> {
  if (!activeChannels.has(channel)) return;
  if (!client || !connected) {
    setTwitchChannel(channel, false);
    return;
  }
  if (isChannelJoined(channel)) {
    setTwitchChannel(channel, true);
    return;
  }
  await client.join(channel);
  await new Promise<void>((resolve) => { setTimeout(resolve, JOIN_THROTTLE_MS); });
  setTwitchChannel(channel, true);
  try { _onChannelJoined?.(channel); } catch (err) { log.error('Channel joined hook error:', err); }
  log.info(`Joined queued channel after reconnect: ${channel}`);
}

async function reconcileJoinedChannels(): Promise<void> {
  if (!client || !connected) return;

  const joinedChannels = client.getChannels()
    .map((channel) => normalizeChannel(channel))
    .filter((channel): channel is string => channel !== null);
  const joinedChannelSet = new Set(joinedChannels);

  for (const channel of joinedChannels) {
    try {
      await membershipMutationQueue.run(channel, () => partStaleChannel(channel));
    } catch (err) {
      log.error(`Failed to part stale channel ${channel}:`, err);
    }
  }

  for (const channel of activeChannels) {
    if (joinedChannelSet.has(channel)) continue;
    try {
      await membershipMutationQueue.run(channel, () => joinMissingChannel(channel));
    } catch (err) {
      setTwitchChannel(channel, false);
      log.error(`Failed to join queued channel ${channel}:`, err);
    }
  }
}

async function initializeActiveChannels(): Promise<void> {
  const configuredChannels = await getTwitchEnabledChannels();
  for (const ch of configuredChannels) {
    const normalized = normalizeChannel(ch);
    if (!normalized) {
      log.error(`Skipping invalid enabled channel in DB: ${ch}`);
      continue;
    }
    activeChannels.add(normalized);
    setTwitchChannel(normalized, false);
  }

  if (activeChannels.size === 0) {
    log.warn('No enabled Twitch channels found in DB; connecting with no joined channels.');
    return;
  }

  try {
    const users = await getUsers([...activeChannels]);
    for (const u of users) activeChannelUserIds.set(u.login.toLowerCase(), u.id);
  } catch (err) {
    log.error('Failed to resolve channel user IDs (shared-chat dedup unavailable):', err);
  }
}

function handleTwitchMessage(
  channel: string,
  tags: tmi.ChatUserstate,
  message: string,
  self: boolean,
): void {
  try {
    if (self) return;
    const normalizedChannel = normalizeChannel(channel);
    if (!normalizedChannel) return;
    if (!activeChannels.has(normalizedChannel)) return;

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
    fireAndForget(executeCountdownForTwitch(normalizedChannel, message, isMod), 'Countdown error');
  } catch (err) {
    log.error('Unexpected error in message handler:', err);
  }
}

function onConnected(addr: string, port: number): void {
  connected = true;
  log.info(`Connected to ${addr}:${port}`);
  log.info(`Listening on: ${[...activeChannels].join(', ') || '(none)'}`);
  // Reset every activeChannels entry via setTwitchChannel to a pessimistic
  // disconnected state until reconcileJoinedChannels() asynchronously
  // rechecks the actual joined memberships and corrects the status.
  activeChannels.forEach((ch) => { setTwitchChannel(ch, false); });
  void reconcileJoinedChannels().catch((err) => {
    log.error('Failed to reconcile joined channels:', err);
  });
}

function onDisconnected(reason: string): void {
  connected = false;
  // Clear tmi.js's confirmed-channel list so it doesn't replay those
  // channels in its auto-rejoin queue on the next connect. All joining
  // is handled by reconcileJoinedChannels after 'connected' fires.
  // tmi.js doesn't expose `channels` in its public types, but it is a real
  // internal array. Clearing it prevents tmi.js from auto-rejoining stale
  // channels on the next connect — all joins are handled by reconcileJoinedChannels.
  (client as any).channels = [];
  log.warn(`Disconnected: ${reason}`);
  activeChannels.forEach((ch) => { setTwitchChannel(ch, false); });
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

export async function joinTwitchChannel(channel: string): Promise<void> {
  const normalized = normalizeChannel(channel);
  if (!normalized) {
    throw new Error(`[Twitch] Invalid channel name: ${channel}`);
  }

  await membershipMutationQueue.run(normalized, async () => {
    // Check inside the mutex so no concurrent join can race between the check
    // and the actual client.join() call.
    if (isChannelJoined(normalized)) {
      // Already joined — sync local tracking so status store and activeChannels
      // agree with the live tmi.js state.
      activeChannels.add(normalized);
      setTwitchChannel(normalized, true);
      return;
    }

    if (!client || !connected) {
      // Queue the desired membership locally so reconnect reconciliation can join
      // it once the Twitch client is available again.
      activeChannels.add(normalized);
      setTwitchChannel(normalized, false);
      getUsers([normalized])
        .then(([u]) => { if (u) activeChannelUserIds.set(normalized, u.id); })
        .catch((err) => { log.warn(`Failed to cache user ID for channel ${normalized}:`, err); });
      return;
    }

    activeChannels.add(normalized);
    setTwitchChannel(normalized, false);
    try {
      await client.join(normalized);
      setTwitchChannel(normalized, true);
      getUsers([normalized])
        .then(([u]) => { if (u) activeChannelUserIds.set(normalized, u.id); })
        .catch((err) => { log.warn(`Failed to cache user ID for channel ${normalized}:`, err); });
    } catch (err) {
      // Roll back local state; reconnect reconciliation will retry via activeChannels.
      activeChannels.delete(normalized);
      setTwitchChannel(normalized, false);
      log.error(`Failed to join channel ${normalized}:`, err);
      throw err;
    }
    try { _onChannelJoined?.(normalized); } catch (err) { log.error('Channel joined hook error:', err); }
  });
}

export async function sayInChannel(channel: string, message: string): Promise<void> {
  const normalized = normalizeChannel(channel);
  if (!normalized) throw new Error(`[Twitch] Invalid channel name: ${channel}`);
  if (!client || !connected) throw new Error(`[Twitch] Cannot send message — not connected`);
  await client.say(normalized, message);
}

export function getActiveChannels(): ReadonlySet<string> {
  return activeChannels;
}

export function getActiveChannelUserIds(): ReadonlyMap<string, string> {
  return activeChannelUserIds;
}

export async function partTwitchChannel(channel: string): Promise<void> {
  const normalized = normalizeChannel(channel);
  if (!normalized) return;

  await membershipMutationQueue.run(normalized, async () => {
    if (!activeChannels.has(normalized) && !isChannelJoined(normalized)) return;

    if (!client || !connected) {
      // We remove local state immediately and let reconcileJoinedChannels() part
      // any stale tmi.js channel memberships on the next successful connect.
      activeChannels.delete(normalized);
      activeChannelUserIds.delete(normalized);
      setTwitchChannel(normalized, false);
      return;
    }

    try {
      activeChannels.delete(normalized);
      activeChannelUserIds.delete(normalized);
      setTwitchChannel(normalized, false);
      if (isChannelJoined(normalized)) {
        await client.part(normalized);
      }
    } catch (err) {
      // Keep desired membership removed so later reconciliation can retry
      // parting any stale runtime join without restoring admin intent here.
      log.error(`Failed to part channel ${normalized}:`, err);
      throw err;
    }
  });
}

export async function stopTwitchBot(): Promise<void> {
  connected = false;
  activeChannels.clear();
  activeChannelUserIds.clear();
  if (client) {
    try {
      await client.disconnect();
    } catch (err) {
      log.warn('Error during disconnect:', err);
    }
    client = null;
  }
  log.info('Disconnected.');
}
