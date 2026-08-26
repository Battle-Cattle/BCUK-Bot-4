import 'mediaplex'; // Must be imported first to register as Opus provider
import { getPool, closePool } from './db';
import { startTwitchBot, stopTwitchBot, sayInChannel } from './twitch/twitchBot';
import { getActiveChannels, getActiveChannelUserIds, setChannelJoinedHook } from './twitch/twitchChannelMembership';
import { startChannelReconciliationPoll, stopChannelReconciliationPoll } from './twitch/twitchChannelReconciliationPoll';
import { startDiscordBot, stopDiscordBot } from './discord/discordBot';
import { reloadGuildRegistry } from './discord/guildRegistry';
import { resolveGuildIdForDiscordId } from './discord/voicePresence';
import { registerTwitchGuildResolutionRuntime } from './twitch/twitchGuildResolutionRuntime';
import { startTwitchMonitor, stopTwitchMonitor, getMultiTwitchDataForChannel } from './twitch/monitor/twitchMonitor';
import { startEventSub, stopEventSub, reloadEventSubSubscriptions } from './twitch/eventsub/twitchEventSub';
import { startEventSubReconciliation, stopEventSubReconciliation } from './twitch/eventsub/twitchEventSubReconciliation';
import { startWebPanel } from './web/server';
import { disconnect } from './audio/audioPlayer';
import { registerTwitchChatRuntime } from './commands/customCommandHandler';
import { registerCounterTwitchRuntime } from './commands/counterHandler';
import { registerMultiTwitchRuntime } from './commands/multiCommandHandler';
import { registerShoutoutRuntime } from './commands/shoutoutHandler';
import { registerCountdownTwitchRuntime } from './commands/countdownHandler';
import {
  registerEventSubOverlayRuntime, registerEventSubTwitchRuntime, registerEventSubCompanionRuntime,
  registerEventSubAlertRuntime, registerEventSubDashboardRuntime, registerEventSubReloadRuntime,
} from './twitch/eventsub/twitchEventSubRuntime';
import { pushOverlayEvent } from './web/routes/overlaySource';
import { pushCompanionEvent } from './web/routes/companionEvents';
import { pushAlertEvent } from './web/routes/alertsOverlaySource';
import { pushPricingUpdate } from './web/routes/channelPointsEvents';
import { pushDashboardEvent } from './web/routes/dashboardEvents';
import { startCounterScheduler, stopCounterScheduler } from './commands/counterScheduler';
import { startRewardPricingScheduler, stopRewardPricingScheduler } from './twitch/pricing/rewardPricingScheduler';
import { registerRewardPricingRuntime } from './twitch/pricing/rewardPricingService';
import { startTimerCommandScheduler, stopTimerCommandScheduler, registerTimerCommandsRuntime } from './twitch/timers/timerCommandScheduler';
import { createLogger } from './shared/logger';

const log = createLogger('Bot');

/**
 * Gracefully stops schedulers and bot connections, closes the DB pool, and exits the process.
 * @param signal - The name of the signal that triggered shutdown (e.g. `SIGINT`).
 */
async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received — disconnecting from voice and shutting down.`);
  stopCounterScheduler();
  stopChannelReconciliationPoll();
  await stopRewardPricingScheduler();
  await stopTimerCommandScheduler();
  await stopEventSubReconciliation();
  stopEventSub();
  await stopTwitchMonitor();
  await stopTwitchBot();
  stopDiscordBot();
  disconnect();
  await closePool();
  process.exit(0);
}

process.on('SIGINT',  () => { shutdown('SIGINT').catch((err)  => { log.error('Shutdown error:', err); process.exit(1); }); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch((err) => { log.error('Shutdown error:', err); process.exit(1); }); });

// Without these, a rejection or throw originating from inside a third-party library's own
// internals (discord.js, @twurple/chat, mysql2, ws) rather than the app's own promise chains would go
// fully unhandled and silently kill the process — there's no supervisor (pm2/systemd) to restart
// it, so we log loudly and exit deliberately instead, making the failure visible and diagnosable.

/**
 * Logs an unhandled promise rejection and exits, rather than letting Node's default
 * (process termination without a clean log line) or silently continuing.
 * @param reason - The rejection reason (typically an `Error`, but not guaranteed to be).
 * @returns Never returns — always calls `process.exit(1)`.
 */
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection:', reason);
  process.exit(1);
});

/**
 * Logs an uncaught synchronous exception and exits — continuing after `uncaughtException` risks
 * running with corrupted state, so this deliberately does not attempt to recover.
 * @param err - The uncaught error.
 * @returns Never returns — always calls `process.exit(1)`.
 */
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err);
  process.exit(1);
});

/**
 * Boots the bot: verifies DB connectivity, wires every Twitch/EventSub runtime callback,
 * loads the guild registry, then starts the Discord bot, Twitch bot, web panel, and
 * schedulers, in that order (see the Startup Sequence section of `CLAUDE.md`).
 * @returns Resolves once every component has started; rejects (and exits the process,
 *   via the `.catch` below) if DB connectivity or the guild registry load fails.
 */
async function main(): Promise<void> {
  log.info('Starting BCUK Bot 4...');

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
    getMultiTwitchDataForChannel,
  });
  registerCounterTwitchRuntime({ send: sayInChannel });
  registerMultiTwitchRuntime({ send: sayInChannel, getActiveChannels, getLoginUserIds: getActiveChannelUserIds });
  registerShoutoutRuntime({ send: sayInChannel });
  registerCountdownTwitchRuntime({ send: sayInChannel });
  registerEventSubOverlayRuntime({ pushOverlayEvent });
  registerEventSubCompanionRuntime({ pushCompanionEvent });
  registerEventSubAlertRuntime({ pushAlertEvent });
  registerEventSubDashboardRuntime({ pushDashboardEvent });
  registerEventSubTwitchRuntime({ send: sayInChannel });
  registerEventSubReloadRuntime({ triggerReload: reloadEventSubSubscriptions });
  registerRewardPricingRuntime({ pushPricingUpdate });
  registerTimerCommandsRuntime({ send: sayInChannel, getLoginUserIds: getActiveChannelUserIds });
  registerTwitchGuildResolutionRuntime({ resolveGuildIdForDiscordId });

  // Load the guild registry before the Discord client connects so the
  // messageCreate gate recognises registered guilds from the first message.
  try {
    await reloadGuildRegistry();
  } catch (err) {
    log.error('Cannot load guild registry:', err);
    process.exit(1);
  }

  setChannelJoinedHook(() => reloadEventSubSubscriptions());
  startDiscordBot();
  await startTwitchBot();
  startWebPanel();
  startChannelReconciliationPoll();
  startCounterScheduler();
  startRewardPricingScheduler();
  startTimerCommandScheduler();

  startTwitchMonitor().catch((err) => log.error('TwitchMonitor startup error:', err));
  startEventSub();
  startEventSubReconciliation();
}

main().catch((err) => {
  log.error('Fatal startup error:', err);
  process.exit(1);
});
