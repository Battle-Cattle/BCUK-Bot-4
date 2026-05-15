import type TypedEmitter from 'typed-emitter';
import type { ClientEventMap, TikTokLiveConnectionState } from 'tiktok-live-connector' with { 'resolution-mode': 'import' };
import { TIKTOK_CHANNELS, TIKTOK_SIGN_API_KEY } from './config';
import { handleCommand } from './commandRouter';
import { setTikTokChannel } from './statusStore';

// TypedEventEmitter<ClientEventMap> is the base of TikTokLiveConnection but TypeScript
// can't resolve it through the library's declaration chain; cast explicitly.
type Connection = TypedEmitter<ClientEventMap> & {
  connect(roomId?: string): Promise<TikTokLiveConnectionState>;
  disconnect(): Promise<void>;
};

const RECONNECT_DELAY_MS = 30_000;

// Tracks the active connection object per channel to prevent duplicate connections.
const activeConnections = new Map<string, Connection>();

export async function startTikTokBot(): Promise<void> {
  if (TIKTOK_CHANNELS.length === 0) {
    console.log('[TikTok] No TIKTOK_CHANNELS configured — TikTok listener not started.');
    return;
  }

  TIKTOK_CHANNELS.forEach((ch) => setTikTokChannel(ch, false));
  console.log(`[TikTok] Connecting to channels: ${TIKTOK_CHANNELS.join(', ')}`);

  // Dynamic import required because tiktok-live-connector 2.3+ is ESM-only
  const { TikTokLiveConnection, WebcastEvent, ControlEvent } = await import('tiktok-live-connector');

  function connectToChannel(username: string): void {
    // Disconnect any existing connection for this channel before creating a new one.
    const existing = activeConnections.get(username);
    if (existing) {
      existing.disconnect().catch(() => { /* already disconnected */ });
      activeConnections.delete(username);
    }

    const connection = new TikTokLiveConnection(username, {
      signApiKey: TIKTOK_SIGN_API_KEY || undefined,
    }) as unknown as Connection;
    activeConnections.set(username, connection);
    let reconnectScheduled = false;
    let permanentFailure = false;

    function scheduleReconnect(): void {
      if (reconnectScheduled || permanentFailure) return;
      reconnectScheduled = true;
      connection.disconnect().catch(() => { /* already disconnected */ });
      // Only take ownership of the map entry and schedule a reconnect when this
      // connection is still the active one — a newer connection may have already
      // replaced it, in which case we must not clobber the map or queue a
      // redundant reconnect.
      if (activeConnections.get(username) === connection) {
        activeConnections.delete(username);
        setTimeout(() => connectToChannel(username), RECONNECT_DELAY_MS);
      }
    }

    connection.on(ControlEvent.CONNECTED, () => {
      console.log(`[TikTok] Connected to @${username}`);
      setTikTokChannel(username, true);
    });

    connection.on(WebcastEvent.CHAT, (data) => {
      handleCommand(data.content, 'tiktok').catch((err) =>
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

    connection.on(ControlEvent.ERROR, (err: unknown) => {
      console.error(`[TikTok] Error on @${username}:`, err);
      // Treat errors that indicate the channel is permanently unavailable as
      // fatal so that the reconnect loop does not spin forever on a bad username
      // or a banned/suspended account.
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|does not exist|banned|suspended|unauthorized|forbidden/i.test(msg)) {
        console.error(`[TikTok] Permanent failure for @${username} — reconnect disabled.`);
        permanentFailure = true;
        activeConnections.delete(username);
      }
    });

    connection
      .connect()
      .then((state) => {
        console.log(`[TikTok] Joined roomId ${state.roomId} for @${username}`);
      })
      .catch((err: Error) => {
        console.warn(`[TikTok] Could not connect to @${username} (${err.message}). Will retry in ${RECONNECT_DELAY_MS / 1000}s`);
        scheduleReconnect();
      });
  }

  for (const username of TIKTOK_CHANNELS) {
    connectToChannel(username);
  }
}
