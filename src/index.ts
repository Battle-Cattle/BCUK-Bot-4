import 'mediaplex'; // Must be imported first to register as Opus provider
import { getPool } from './db';
import { startTwitchBot } from './twitchBot';
import { startDiscordBot } from './discordBot';
import { startTikTokBot } from './tiktokBot';
import { startTwitchMonitor, stopTwitchMonitor } from './twitchMonitor';
import { startWebPanel } from './web/server';
import { disconnect } from './audioPlayer';

function shutdown(signal: string): void {
  console.log(`[Bot] ${signal} received — disconnecting from voice and shutting down.`);
  stopTwitchMonitor();
  disconnect();
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

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

  startDiscordBot();
  startTwitchBot();
  startTikTokBot();
  startWebPanel();
  startTwitchMonitor().catch((err) => console.error('[Bot] TwitchMonitor startup error:', err));
}

main();
