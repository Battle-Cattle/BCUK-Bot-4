import 'mediaplex'; // Must be imported first to register as Opus provider
import { getPool, closePool } from './db';
import { startTwitchBot, sayInChannel, getActiveChannels } from './twitchBot';
import { startDiscordBot } from './discordBot';
import { startTikTokBot } from './tiktokBot';
import { startTwitchMonitor, stopTwitchMonitor, getMonitoredLoginUserIds } from './twitchMonitor';
import { startWebPanel } from './web/server';
import { disconnect } from './audioPlayer';
import { registerTwitchChatRuntime } from './customCommandHandler';

async function shutdown(signal: string): Promise<void> {
  console.log(`[Bot] ${signal} received — disconnecting from voice and shutting down.`);
  await stopTwitchMonitor();
  disconnect();
  await closePool();
  process.exit(0);
}

process.on('SIGINT',  () => { shutdown('SIGINT').catch((err)  => { console.error('[Bot] Shutdown error:', err); process.exit(1); }); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch((err) => { console.error('[Bot] Shutdown error:', err); process.exit(1); }); });

async function main(): Promise<void> {
  console.log('[Bot] Starting BCUK SFX Bot...');

  // Verify DB connection early
  try {
    const pool = getPool();
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    console.log('[Bot] Database connection OK');
  } catch (err) {
    console.error('[Bot] Cannot connect to database:', err);
    process.exit(1);
  }

  // Wire Twitch send/channel helpers before the bot connects so the first
  // message can already use the execute path (functions capture live state).
  registerTwitchChatRuntime({
    send: sayInChannel,
    getActiveChannels,
    getLoginUserIds: getMonitoredLoginUserIds,
  });

  startDiscordBot();
  await startTwitchBot();
  startTikTokBot();
  startWebPanel();
  startTwitchMonitor().catch((err) => console.error('[Bot] TwitchMonitor startup error:', err));
}

main().catch((err) => {
  console.error('[Bot] Fatal startup error:', err);
  process.exit(1);
});
