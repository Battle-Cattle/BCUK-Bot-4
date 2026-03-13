import tmi from 'tmi.js';
import { TWITCH_USERNAME, TWITCH_OAUTH_TOKEN, TWITCH_CHANNELS } from './config';
import { handleCommand } from './commandRouter';
import { setTwitchChannel } from './statusStore';

let client: tmi.Client;

export function startTwitchBot(): void {
  // Seed all configured channels as disconnected so they appear in status immediately
  TWITCH_CHANNELS.forEach((ch) => { setTwitchChannel(ch, false); });

  client = new tmi.Client({
    identity: {
      username: TWITCH_USERNAME,
      password: TWITCH_OAUTH_TOKEN,
    },
    channels: TWITCH_CHANNELS,
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
    console.log(`[Twitch] Connected to ${addr}:${port}`);
    console.log(`[Twitch] Listening on: ${TWITCH_CHANNELS.join(', ')}`);
    TWITCH_CHANNELS.forEach((ch) => { setTwitchChannel(ch, true); });
  });

  client.on('disconnected', (reason) => {
    console.warn(`[Twitch] Disconnected: ${reason}`);
    TWITCH_CHANNELS.forEach((ch) => { setTwitchChannel(ch, false); });
  });

  client.connect().catch((err) => console.error('[Twitch] Failed to connect:', err));
}
