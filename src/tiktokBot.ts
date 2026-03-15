import { TikTokLiveConnection, WebcastEvent, ControlEvent, SignConfig } from 'tiktok-live-connector';
import { TIKTOK_CHANNELS, TIKTOK_SIGN_API_KEY } from './config';
import { handleCommand } from './commandRouter';
import { setTikTokChannel } from './statusStore';

// Configure sign API key if provided
if (TIKTOK_SIGN_API_KEY) {
  SignConfig.apiKey = TIKTOK_SIGN_API_KEY;
}

const RECONNECT_DELAY_MS = 30_000; // Wait 30s before attempting reconnect after stream ends/disconnect

function connectToChannel(username: string): void {
  const connection = new TikTokLiveConnection(username);
  let reconnectScheduled = false;

  function scheduleReconnect(): void {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    try { connection.disconnect(); } catch { /* already disconnected or never connected */ }
    setTimeout(() => connectToChannel(username), RECONNECT_DELAY_MS);
  }

  connection.on(ControlEvent.CONNECTED, () => {
    console.log(`[TikTok] Connected to @${username}`);
    setTikTokChannel(username, true);
  });

  // Chat message event — the comment field contains the raw text
  connection.on(WebcastEvent.CHAT, (data) => {
    handleCommand(data.comment, 'tiktok').catch((err) =>
      console.error(`[TikTok] Command handler error (${username}):`, err),
    );
  });

  connection.on(WebcastEvent.STREAM_END, () => {
    console.log(`[TikTok] Stream ended for @${username}. Will retry in ${RECONNECT_DELAY_MS / 1000}s`);
    setTikTokChannel(username, false);
    scheduleReconnect();
  });

  connection.on(ControlEvent.DISCONNECTED, () => {
    console.warn(`[TikTok] Disconnected from @${username}. Will retry in ${RECONNECT_DELAY_MS / 1000}s`);
    setTikTokChannel(username, false);
    scheduleReconnect();
  });

  connection.on(ControlEvent.ERROR, (err) => {
    console.error(`[TikTok] Error on @${username}:`, err);
  });

  connection
    .connect()
    .then((state) => {
      console.log(`[TikTok] Joined roomId ${state.roomId} for @${username}`);
    })
    .catch((err: Error) => {
      // Streamer is likely offline — retry later
      console.warn(`[TikTok] Could not connect to @${username} (${err.message}). Will retry in ${RECONNECT_DELAY_MS / 1000}s`);
      scheduleReconnect();
    });
}

export function startTikTokBot(): void {
  if (TIKTOK_CHANNELS.length === 0) {
    console.log('[TikTok] No TIKTOK_CHANNELS configured — TikTok listener not started.');
    return;
  }

  // Seed all configured channels as disconnected so they appear in status immediately
  TIKTOK_CHANNELS.forEach((ch) => setTikTokChannel(ch, false));

  console.log(`[TikTok] Connecting to channels: ${TIKTOK_CHANNELS.join(', ')}`);
  for (const username of TIKTOK_CHANNELS) {
    connectToChannel(username);
  }
}
