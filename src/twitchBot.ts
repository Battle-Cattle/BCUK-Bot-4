import tmi from 'tmi.js';
import { TWITCH_USERNAME, TWITCH_OAUTH_TOKEN } from './config';
import { handleCommand } from './commandRouter';
import { setTwitchChannel } from './statusStore';
import { getTwitchEnabledChannels } from './db';

let client: tmi.Client | null = null;
let connected = false;
const activeChannels = new Set<string>();
const TWITCH_CHANNEL_NAME_PATTERN = /^[a-z0-9_]{4,25}$/;

export function normalizeTwitchChannelName(channel: string): string | null {
  const normalized = channel.trim().replace(/^#/, '').toLowerCase();
  return TWITCH_CHANNEL_NAME_PATTERN.test(normalized) ? normalized : null;
}

function normalizeChannel(channel: string): string {
  return normalizeTwitchChannelName(channel) ?? '';
}

async function reconcileJoinedChannels(): Promise<void> {
  if (!client || !connected) return;

  const joinedChannels = client.getChannels()
    .map((channel) => normalizeChannel(channel))
    .filter((channel) => channel.length > 0);
  const joinedChannelSet = new Set(joinedChannels);

  for (const channel of joinedChannels) {
    if (activeChannels.has(channel)) {
      setTwitchChannel(channel, true);
      continue;
    }

    try {
      await client.part(channel);
      setTwitchChannel(channel, false);
      console.log(`[Twitch] Parted stale channel after reconnect: ${channel}`);
    } catch (err) {
      console.error(`[Twitch] Failed to part stale channel ${channel}:`, err);
    }
  }

  for (const channel of activeChannels) {
    if (joinedChannelSet.has(channel)) continue;

    try {
      await client.join(channel);
      setTwitchChannel(channel, true);
      console.log(`[Twitch] Joined queued channel after reconnect: ${channel}`);
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
  if (activeChannels.has(normalized)) return;

  if (!client || !connected) {
    // Queue the desired membership locally so reconnect reconciliation can join
    // it once the Twitch client is available again.
    activeChannels.add(normalized);
    setTwitchChannel(normalized, false);
    return;
  }

  try {
    await client.join(normalized);
    activeChannels.add(normalized);
    setTwitchChannel(normalized, true);
  } catch (err) {
    console.error(`[Twitch] Failed to join channel ${normalized}:`, err);
    throw err;
  }
}

export async function partTwitchChannel(channel: string): Promise<void> {
  const normalized = normalizeChannel(channel);
  if (!normalized || !activeChannels.has(normalized)) return;

  if (!client || !connected) {
    // We remove local state immediately and let reconcileJoinedChannels() part
    // any stale tmi.js channel memberships on the next successful connect.
    activeChannels.delete(normalized);
    setTwitchChannel(normalized, false);
    return;
  }

  try {
    await client.part(normalized);
    activeChannels.delete(normalized);
    setTwitchChannel(normalized, false);
  } catch (err) {
    console.error(`[Twitch] Failed to part channel ${normalized}:`, err);
    throw err;
  }
}
