import tmi from 'tmi.js';
import { TWITCH_USERNAME, TWITCH_OAUTH_TOKEN } from './config';
import { handleCommand } from './commandRouter';
import { setTwitchChannel } from './statusStore';
import { getTwitchEnabledChannels } from './db';
import { normalizeTwitchChannelName } from './twitchChannelName';

let client: tmi.Client | null = null;
let connected = false;
const activeChannels = new Set<string>();
const membershipMutationQueues = new Map<string, Promise<void>>();

function normalizeChannel(channel: string): string | null {
  return normalizeTwitchChannelName(channel);
}

function isChannelJoined(channel: string): boolean {
  if (!client || !connected) return false;
  return client.getChannels().some((joinedChannel) => normalizeChannel(joinedChannel) === channel);
}

async function withMembershipMutationLock<T>(channel: string, operation: () => Promise<T>): Promise<T> {
  const previous = membershipMutationQueues.get(channel) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = (async () => {
    try {
      await previous;
    } catch {
      // Ignore earlier failures so later membership changes still run.
    }
    await current;
  })();
  membershipMutationQueues.set(channel, queued);

  try {
    await previous;
  } catch {
    // Ignore earlier failures so later membership changes still run.
  }

  try {
    return await operation();
  } finally {
    release();
    if (membershipMutationQueues.get(channel) === queued) {
      membershipMutationQueues.delete(channel);
    }
  }
}

async function reconcileJoinedChannels(): Promise<void> {
  if (!client || !connected) return;

  const joinedChannels = client.getChannels()
    .map((channel) => normalizeChannel(channel))
    .filter((channel): channel is string => channel !== null);
  const joinedChannelSet = new Set(joinedChannels);

  for (const channel of joinedChannels) {
    try {
      await withMembershipMutationLock(channel, async () => {
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
      });
    } catch (err) {
      console.error(`[Twitch] Failed to part stale channel ${channel}:`, err);
    }
  }

  for (const channel of activeChannels) {
    if (joinedChannelSet.has(channel)) continue;

    try {
      await withMembershipMutationLock(channel, async () => {
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
      });
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
    // Don't respond to own messages
    if (self) return;
    const normalizedChannel = normalizeChannel(channel);
    if (!normalizedChannel) return;
    if (!activeChannels.has(normalizedChannel)) return;
    handleCommand(message, 'twitch').catch((err) =>
      console.error('[Twitch] Command handler error:', err),
    );
  });

  client.on('connected', (addr, port) => {
    connected = true;
    console.log(`[Twitch] Connected to ${addr}:${port}`);
    console.log(`[Twitch] Listening on: ${[...activeChannels].join(', ') || '(none)'}`);
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

  await withMembershipMutationLock(normalized, async () => {
    if (activeChannels.has(normalized)) {
      // When the desired membership is already queued offline we should still no-op,
      // but if a previous live join failed we need to retry once the client is connected.
      if (!client || !connected || isChannelJoined(normalized)) return;
    }

    if (!client || !connected) {
      // Queue the desired membership locally so reconnect reconciliation can join
      // it once the Twitch client is available again.
      activeChannels.add(normalized);
      setTwitchChannel(normalized, false);
      return;
    }

    try {
      activeChannels.add(normalized);
      setTwitchChannel(normalized, false);
      await client.join(normalized);
      setTwitchChannel(normalized, true);
    } catch (err) {
      activeChannels.delete(normalized);
      setTwitchChannel(normalized, false);
      console.error(`[Twitch] Failed to join channel ${normalized}:`, err);
      throw err;
    }
  });
}

export async function partTwitchChannel(channel: string): Promise<void> {
  const normalized = normalizeChannel(channel);
  if (!normalized) return;

  await withMembershipMutationLock(normalized, async () => {
    if (!activeChannels.has(normalized) && !isChannelJoined(normalized)) return;

    if (!client || !connected) {
      // We remove local state immediately and let reconcileJoinedChannels() part
      // any stale tmi.js channel memberships on the next successful connect.
      activeChannels.delete(normalized);
      setTwitchChannel(normalized, false);
      return;
    }

    try {
      activeChannels.delete(normalized);
      setTwitchChannel(normalized, false);
      if (isChannelJoined(normalized)) {
        await client.part(normalized);
      }
    } catch (err) {
      activeChannels.add(normalized);
      setTwitchChannel(normalized, isChannelJoined(normalized));
      console.error(`[Twitch] Failed to part channel ${normalized}:`, err);
      throw err;
    }
  });
}
