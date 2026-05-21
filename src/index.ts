import 'mediaplex'; // Must be imported first to register as Opus provider
import { getPool, closePool } from './db';
import { startTwitchBot, stopTwitchBot, sayInChannel, getActiveChannels, getActiveChannelUserIds } from './twitchBot';
import { startDiscordBot, stopDiscordBot } from './discordBot';
import { startTikTokBot, stopTikTokBot } from './tiktokBot';
import { startTwitchMonitor, stopTwitchMonitor } from './twitchMonitor';
import { startWebPanel } from './web/server';
import { disconnect } from './audioPlayer';
import { registerTwitchChatRuntime } from './customCommandHandler';
import { registerCounterTwitchRuntime } from './counterHandler';
import { registerMultiTwitchRuntime } from './multiCommandHandler';
import { registerShoutoutRuntime } from './shoutoutHandler';
import { registerCountdownTwitchRuntime } from './countdownHandler';
import { startCounterScheduler, stopCounterScheduler } from './counterScheduler';
import { createLogger } from './logger';

const log = createLogger('Bot');

async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received — disconnecting from voice and shutting down.`);
  stopCounterScheduler();
  await stopTwitchMonitor();
  stopTikTokBot();
  await stopTwitchBot();
  stopDiscordBot();
  disconnect();
  await closePool();
  process.exit(0);
}

process.on('SIGINT',  () => { shutdown('SIGINT').catch((err)  => { log.error('Shutdown error:', err); process.exit(1); }); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch((err) => { log.error('Shutdown error:', err); process.exit(1); }); });

async function main(): Promise<void> {
  log.info('Starting BCUK SFX Bot...');

  // Verify DB connection early
  try {
    const pool = getPool();
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    log.info('Database connection OK');
  } catch (err) {
    log.error('Cannot connect to database:', err);
    process.exit(1);
  }

  // Wire Twitch send/channel helpers before the bot connects so the first
  // message can already use the execute path (functions capture live state).
  registerTwitchChatRuntime({
    send: sayInChannel,
    getActiveChannels,
    getLoginUserIds: getActiveChannelUserIds,
  });
  registerCounterTwitchRuntime({ send: sayInChannel });
  registerMultiTwitchRuntime({ send: sayInChannel, getActiveChannels, getLoginUserIds: getActiveChannelUserIds });
  registerShoutoutRuntime({ send: sayInChannel });
  registerCountdownTwitchRuntime({ send: sayInChannel });

  startDiscordBot();
  await startTwitchBot();
  await startTikTokBot();
  startWebPanel();
  startCounterScheduler();
  startTwitchMonitor().catch((err) => log.error('TwitchMonitor startup error:', err));
}

main().catch((err) => {
  log.error('Fatal startup error:', err);
  process.exit(1);
});
