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

export function startTikTokBot(): void {
  if (TIKTOK_CHANNELS.length === 0) {
    console.log('[TikTok] No TIKTOK_CHANNELS configured — TikTok listener not started.');
    return;
  }

  TIKTOK_CHANNELS.forEach((ch) => setTikTokChannel(ch, false));
  console.log(`[TikTok] Connecting to channels: ${TIKTOK_CHANNELS.join(', ')}`);

  // Dynamic import required because tiktok-live-connector 2.3+ is ESM-only
  import('tiktok-live-connector')
    .then(({ TikTokLiveConnection, WebcastEvent, ControlEvent }) => {
      function connectToChannel(username: string): void {
        const connection = new TikTokLiveConnection(username, {
          signApiKey: TIKTOK_SIGN_API_KEY || undefined,
        }) as unknown as Connection;
        let reconnectScheduled = false;

        function scheduleReconnect(): void {
          if (reconnectScheduled) return;
          reconnectScheduled = true;
          connection.disconnect().catch(() => { /* already disconnected */ });
          setTimeout(() => connectToChannel(username), RECONNECT_DELAY_MS);
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
    })
    .catch((err: Error) => {
      console.error('[TikTok] Failed to load tiktok-live-connector:', err);
    });
}
