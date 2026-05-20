import tmi from 'tmi.js';
import { TWITCH_USERNAME, TWITCH_OAUTH_TOKEN } from './config';
import { handleCommand } from './commandRouter';
import { executeCustomCommandForTwitch } from './customCommandHandler';
import { executeCounterCommandForTwitch } from './counterHandler';
import { executeMultiCommandForTwitch } from './multiCommandHandler';
import { executeShoutoutForTwitch } from './shoutoutHandler';
import { executeCountdownForTwitch } from './countdownHandler';
import { setTwitchChannel } from './statusStore';
import { getTwitchEnabledChannels } from './db';
import { normalizeTwitchChannelName } from './twitchChannelName';
import { getUsers } from './twitchApi';
import { createMutationQueue } from './mutationQueue';

let client: tmi.Client | null = null;
let connected = false;
const activeChannels = new Set<string>();
const activeChannelUserIds = new Map<string, string>();
const membershipMutationQueue = createMutationQueue();

function normalizeChannel(channel: string): string | null {
  return normalizeTwitchChannelName(channel);
}

function isChannelJoined(channel: string): boolean {
  if (!client || !connected) return false;
  return client.getChannels().some((joinedChannel) => normalizeChannel(joinedChannel) === channel);
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
  console.log(`[Twitch] Parted stale channel after reconnect: ${channel}`);
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
  setTwitchChannel(channel, true);
  console.log(`[Twitch] Joined queued channel after reconnect: ${channel}`);
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
      console.error(`[Twitch] Failed to part stale channel ${channel}:`, err);
    }
  }

  for (const channel of activeChannels) {
    if (joinedChannelSet.has(channel)) continue;
    try {
      await membershipMutationQueue.run(channel, () => joinMissingChannel(channel));
    } catch (err) {
      setTwitchChannel(channel, false);
      console.error(`[Twitch] Failed to join queued channel ${channel}:`, err);
    }
  }
}

export async function startTwitchBot(): Promise<void> {
  const configuredChannels = await getTwitchEnabledChannels();
  for (const ch of configuredChannels) {
    const normalized = normalizeChannel(ch);
    if (!normalized) {
      console.error(`[Twitch] Skipping invalid enabled channel in DB: ${ch}`);
      continue;
    }
    activeChannels.add(normalized);
    setTwitchChannel(normalized, false);
  }

  if (activeChannels.size === 0) {
    console.warn('[Twitch] No enabled Twitch channels found in DB; connecting with no joined channels.');
  }

  if (activeChannels.size > 0) {
    try {
      const users = await getUsers([...activeChannels]);
      for (const u of users) activeChannelUserIds.set(u.login.toLowerCase(), u.id);
    } catch (err) {
      console.error('[Twitch] Failed to resolve channel user IDs (shared-chat dedup unavailable):', err);
    }
  }

  client = new tmi.Client({
    identity: {
      username: TWITCH_USERNAME,
      password: TWITCH_OAUTH_TOKEN,
    },
    channels: [...activeChannels],
    options: { debug: false },
    connection: {
      reconnect: true,
      secure: true,
    },
  });

  client.on('message', (channel, tags, message, self) => {
    try {
      // Don't respond to own messages
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

      executeCustomCommandForTwitch(normalizedChannel, message, displayName).catch((err) =>
        console.error('[Twitch] Custom command error:', err),
      );

      executeCounterCommandForTwitch(normalizedChannel, message, displayName).catch((err) =>
        console.error('[Twitch] Counter command error:', err),
      );

      executeMultiCommandForTwitch(normalizedChannel, message, displayName).catch((err) =>
        console.error('[Twitch] Multi command error:', err),
      );

      executeShoutoutForTwitch(normalizedChannel, message, displayName, isMod).catch((err) =>
        console.error('[Twitch] Shoutout error:', err),
      );

      handleCommand(message, 'twitch').catch((err) =>
        console.error('[Twitch] Command handler error:', err),
      );

      executeCountdownForTwitch(normalizedChannel, message).catch((err) =>
        console.error('[Twitch] Countdown error:', err),
      );
    } catch (err) {
      console.error('[Twitch] Unexpected error in message handler:', err);
    }
  });

  client.on('connected', (addr, port) => {
    connected = true;
    console.log(`[Twitch] Connected to ${addr}:${port}`);
    console.log(`[Twitch] Listening on: ${[...activeChannels].join(', ') || '(none)'}`);
    // Reset every activeChannels entry via setTwitchChannel to a pessimistic
    // disconnected state until reconcileJoinedChannels() asynchronously
    // rechecks the actual joined memberships and corrects the status.
    activeChannels.forEach((ch) => { setTwitchChannel(ch, false); });
    void reconcileJoinedChannels().catch((err) => {
      console.error('[Twitch] Failed to reconcile joined channels:', err);
    });
  });

  client.on('disconnected', (reason) => {
    connected = false;
    console.warn(`[Twitch] Disconnected: ${reason}`);
    activeChannels.forEach((ch) => { setTwitchChannel(ch, false); });
  });

  try {
    await client.connect();
  } catch (err) {
    console.error('[Twitch] Failed to connect:', err);
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
        .catch(() => { /* best-effort */ });
      return;
    }

    activeChannels.add(normalized);
    setTwitchChannel(normalized, false);
    try {
      await client.join(normalized);
      setTwitchChannel(normalized, true);
      getUsers([normalized])
        .then(([u]) => { if (u) activeChannelUserIds.set(normalized, u.id); })
        .catch(() => { /* best-effort */ });
    } catch (err) {
      // Roll back local state; reconnect reconciliation will retry via activeChannels.
      activeChannels.delete(normalized);
      setTwitchChannel(normalized, false);
      console.error(`[Twitch] Failed to join channel ${normalized}:`, err);
      throw err;
    }
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
      console.error(`[Twitch] Failed to part channel ${normalized}:`, err);
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
      console.warn('[Twitch] Error during disconnect:', err);
    }
    client = null;
  }
  console.log('[Twitch] Disconnected.');
}
