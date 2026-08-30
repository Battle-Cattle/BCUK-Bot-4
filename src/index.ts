import 'mediaplex'; // Must be imported first to register as Opus provider
import { getPool, closePool, pingDb } from './db';
import { recordDbPing } from './shared/healthStore';
import { registerOwnerAlertRuntime, primeOwnerAlertBaseline, startOwnerAlertWatcher, stopOwnerAlertWatcher, announceShutdown, announceStartup } from './discord/ownerAlerts';
import { startTwitchBot, stopTwitchBot, sayInChannel } from './twitch/twitchBot';
import { getActiveChannels, getActiveChannelUserIds, setChannelJoinedHook } from './twitch/twitchChannelMembership';
import { startChannelReconciliationPoll, stopChannelReconciliationPoll } from './twitch/twitchChannelReconciliationPoll';
import { startDiscordBot, stopDiscordBot, getDiscordClient } from './discord/discordBot';
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

/** How often the DB-connectivity health check pings the pool (see {@link startDbHealthCheck}). */
const DB_HEALTH_CHECK_INTERVAL_MS = 60_000;

let dbHealthCheckTimer: ReturnType<typeof setInterval> | null = null;
// Guards against overlapping probes: pingDb()'s getConnection() has no timeout of its own, so
// a pool that's exhausted/wedged could in principle keep a probe in flight past the next
// interval tick — this flag makes an overlap a no-op instead of stacking probes.
let dbHealthCheckInFlight = false;

/**
 * Starts the periodic DB-connectivity health check: pings the pool every
 * {@link DB_HEALTH_CHECK_INTERVAL_MS} and records the outcome in `healthStore`, so the owner
 * health dashboard/`!health` command/owner-alert watcher reflect live DB reachability, not just
 * the one-off ping `main()` already does at startup. No-ops if already started.
 */
function startDbHealthCheck(): void {
  if (dbHealthCheckTimer) return;
  dbHealthCheckTimer = setInterval(() => {
    if (dbHealthCheckInFlight) return;
    dbHealthCheckInFlight = true;
    void pingDb()
      .then((ok) => recordDbPing(ok, ok ? undefined : 'DB ping failed'))
      .catch((err: unknown) => log.error('Unexpected error during DB health check:', err))
      .finally(() => { dbHealthCheckInFlight = false; });
  }, DB_HEALTH_CHECK_INTERVAL_MS);
  // Doesn't keep the process alive on its own — same reasoning as this codebase's other
  // background-purge intervals (e.g. twitchEventSubConnection.ts's message-dedup sweep):
  // shutdown() always clears it explicitly, so unref only matters for a process that would
  // otherwise exit cleanly (e.g. a test importing this module) with this timer still pending.
  dbHealthCheckTimer.unref();
}

/** Stops the periodic DB-connectivity health check, if running. */
function stopDbHealthCheck(): void {
  if (dbHealthCheckTimer) { clearInterval(dbHealthCheckTimer); dbHealthCheckTimer = null; }
}

/**
 * Gracefully stops schedulers and bot connections, closes the DB pool, and exits the process.
 * Turns off owner-alert status reporting first and sends the owner a "shutting down" DM (see
 * `ownerAlerts.ts`'s `stopOwnerAlertWatcher`/`announceShutdown`) before anything actually
 * disconnects.
 * @param signal - The name of the signal that triggered shutdown (e.g. `SIGINT`).
 */
async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received — disconnecting from voice and shutting down.`);
  // Before anything else — every stop* call below disconnects a component (Twitch chat, EventSub,
  // etc.), and none of that is a real outage the owner needs a DM about.
  stopOwnerAlertWatcher();
  // ...then announce the shutdown itself, while the Discord client this DM needs is still up —
  // stopDiscordBot() below tears it down.
  await announceShutdown();
  stopDbHealthCheck();
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
 * schedulers, in that order (see the Startup Sequence section of `CLAUDE.md`), finishing with
 * an owner DM (see `ownerAlerts.ts`'s `announceStartup`) confirming the bot is back online —
 * paired with `shutdown()`'s `announceShutdown` DM.
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
    recordDbPing(true);
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
  registerOwnerAlertRuntime({
    send: async (discordId, message) => {
      const client = getDiscordClient();
      if (!client) throw new Error('Discord client is not ready');
      const user = await client.users.fetch(discordId);
      await user.send(message);
    },
  });
  await primeOwnerAlertBaseline();
  startOwnerAlertWatcher();
  await startTwitchBot();
  startWebPanel();
  startChannelReconciliationPoll();
  startCounterScheduler();
  startRewardPricingScheduler();
  startTimerCommandScheduler();
  startDbHealthCheck();

  startTwitchMonitor().catch((err) => log.error('TwitchMonitor startup error:', err));
  startEventSub();
  startEventSubReconciliation();
  await announceStartup();
}

main().catch((err) => {
  log.error('Fatal startup error:', err);
  process.exit(1);
});
