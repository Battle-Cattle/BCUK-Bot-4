import tmi from 'tmi.js';
import { TWITCH_USERNAME, TWITCH_OAUTH_TOKEN } from './config';
import { handleCommand } from './commandRouter';
import { setTwitchChannel } from './statusStore';
import { getTwitchEnabledChannels } from './db';

let client: tmi.Client | null = null;
let connected = false;
const activeChannels = new Set<string>();

function normalizeChannel(channel: string): string {
  return channel.trim().replace(/^#/, '').toLowerCase();
}

export async function startTwitchBot(): Promise<void> {
  const configuredChannels = await getTwitchEnabledChannels();
  configuredChannels.forEach((ch) => {
    const normalized = normalizeChannel(ch);
    if (!normalized) return;
    activeChannels.add(normalized);
    setTwitchChannel(normalized, false);
  });

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

  client.on('message', (_channel, tags, message, self) => {
    // Don't respond to own messages
    if (self) return;
    handleCommand(message, 'twitch').catch((err) =>
      console.error('[Twitch] Command handler error:', err),
    );
  });

  client.on('connected', (addr, port) => {
    connected = true;
    console.log(`[Twitch] Connected to ${addr}:${port}`);
    console.log(`[Twitch] Listening on: ${[...activeChannels].join(', ') || '(none)'}`);
    activeChannels.forEach((ch) => { setTwitchChannel(ch, true); });
  });

  client.on('disconnected', (reason) => {
    connected = false;
    console.warn(`[Twitch] Disconnected: ${reason}`);
    activeChannels.forEach((ch) => { setTwitchChannel(ch, false); });
  });

  await client.connect().catch((err) => console.error('[Twitch] Failed to connect:', err));
}

export async function joinTwitchChannel(channel: string): Promise<void> {
  const normalized = normalizeChannel(channel);
  if (!normalized || activeChannels.has(normalized)) return;

  activeChannels.add(normalized);
  setTwitchChannel(normalized, false);

  if (!client || !connected) return;
  try {
    await client.join(normalized);
    setTwitchChannel(normalized, true);
  } catch (err) {
    console.error(`[Twitch] Failed to join channel ${normalized}:`, err);
    activeChannels.delete(normalized);
    setTwitchChannel(normalized, false);
  }
}

export async function partTwitchChannel(channel: string): Promise<void> {
  const normalized = normalizeChannel(channel);
  if (!normalized || !activeChannels.has(normalized)) return;

  activeChannels.delete(normalized);
  setTwitchChannel(normalized, false);

  if (!client || !connected) return;
  await client.part(normalized);
}
