import 'mediaplex'; // Must be imported first to register as Opus provider
import { getPool, closePool, pingDb, isRedemptionLedgerReady } from './db';
import { recordDbPing } from './shared/healthStore';
import { registerOwnerAlertRuntime, primeOwnerAlertBaseline, startOwnerAlertWatcher, stopOwnerAlertWatcher, announceShutdown, announceStartup } from './discord/ownerAlerts';
import { startTwitchBot, stopTwitchBot, sayInChannel } from './twitch/twitchBot';
import { getActiveChannels, getActiveChannelUserIds, setChannelJoinedHook } from './twitch/twitchChannelMembership';
import { startChannelReconciliationPoll, stopChannelReconciliationPoll } from './twitch/twitchChannelReconciliationPoll';
import { startDiscordBot, stopDiscordBot, getDiscordClient, waitForDiscordReady } from './discord/discordBot';
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
import { registerFollowageRuntime } from './commands/followageHandler';
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
import { withTimeout } from './shared/withTimeout';

const log = createLogger('Bot');

/** How often the DB-connectivity health check pings the pool (see {@link startDbHealthCheck}). */
const DB_HEALTH_CHECK_INTERVAL_MS = 60_000;

/**
 * Upper bound on a single health-check {@link pingDb} call. `pingDb()`'s `getConnection()` has no
 * timeout of its own, so without this a wedged pool would leave the probe (and the in-flight
 * guard) pending forever while `healthStore` kept reporting the last successful ping.
 */
const DB_HEALTH_CHECK_TIMEOUT_MS = 10_000;

/**
 * How long an owner-alert DM (including `main()`'s `announceStartup()` DM) waits for Discord to
 * fire `clientReady` before giving up. `startDiscordBot()` is fire-and-forget — `getDiscordClient()`
 * stays null until `clientReady` fires, which can still be pending when an alert is raised during
 * startup — so the owner-alert runtime waits for it explicitly rather than finding no client and
 * failing to deliver (see `discordBot.ts`'s `waitForDiscordReady`).
 */
const DISCORD_READY_FOR_OWNER_DM_TIMEOUT_MS = 30_000;

let dbHealthCheckTimer: ReturnType<typeof setInterval> | null = null;
// Guards against overlapping probes: each probe is bounded by DB_HEALTH_CHECK_TIMEOUT_MS, which
// is well under the interval, but this flag still makes any overlap a no-op instead of
// stacking probes.
let dbHealthCheckInFlight = false;

/**
 * Starts the periodic DB-connectivity health check: pings the pool every
 * {@link DB_HEALTH_CHECK_INTERVAL_MS} and records the outcome in `healthStore`, so the owner
 * health dashboard/`!health` command/owner-alert watcher reflect live DB reachability, not just
 * the one-off ping `main()` already does at startup. Each ping is bounded by
 * {@link DB_HEALTH_CHECK_TIMEOUT_MS}; a timeout or rejection is recorded as a failed ping.
 * No-ops if already started.
 */
function startDbHealthCheck(): void {
  if (dbHealthCheckTimer) return;
  dbHealthCheckTimer = setInterval(() => {
    if (dbHealthCheckInFlight) return;
    dbHealthCheckInFlight = true;
    void withTimeout(pingDb(), DB_HEALTH_CHECK_TIMEOUT_MS, 'DB health check ping')
      .then((ok) => recordDbPing(ok, ok ? undefined : 'DB ping failed'))
      .catch((err: unknown) => {
        log.error('Unexpected error during DB health check:', err);
        // A hung or rejected ping is a DB failure too — record it so healthStore doesn't keep
        // reporting the last successful ping.
        recordDbPing(false, err instanceof Error ? err.message : String(err));
      })
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

/** Set by the first {@link shutdown} call so a second SIGINT/SIGTERM can't run a concurrent teardown. */
let shuttingDown = false;

/**
 * Runs one shutdown teardown step, logging and swallowing any failure so it can't prevent later
 * steps — in particular `closePool()` — from running. See {@link shutdown}.
 * @param name - Human-readable label for the step, used only in the error log.
 * @param fn - The teardown step to run.
 */
async function safeStop(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.error(`Error stopping ${name} during shutdown:`, err);
  }
}

/**
 * Gracefully stops schedulers and bot connections, closes the DB pool, and exits the process.
 * Turns off owner-alert status reporting first and sends the owner a "shutting down" DM (see
 * `ownerAlerts.ts`'s `stopOwnerAlertWatcher`/`announceShutdown`) before anything actually
 * disconnects. Each teardown step is isolated via {@link safeStop} so a failure in one component
 * (e.g. the Twitch monitor) can't skip the rest — `closePool()` and `process.exit(0)` always run.
 * Re-entrant calls (a second signal while teardown is still running) are logged and ignored.
 * @param signal - The name of the signal that triggered shutdown (e.g. `SIGINT`).
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    log.info(`${signal} received — shutdown already in progress, ignoring.`);
    return;
  }
  shuttingDown = true;
  log.info(`${signal} received — disconnecting from voice and shutting down.`);
  // Before anything else — every stop* call below disconnects a component (Twitch chat, EventSub,
  // etc.), and none of that is a real outage the owner needs a DM about.
  stopOwnerAlertWatcher();
  // ...then announce the shutdown itself, while the Discord client this DM needs is still up —
  // stopDiscordBot() below tears it down.
  await safeStop('owner alert shutdown announcement', announceShutdown);
  stopDbHealthCheck();
  stopCounterScheduler();
  stopChannelReconciliationPoll();
  await safeStop('reward pricing scheduler', stopRewardPricingScheduler);
  await safeStop('timer command scheduler', stopTimerCommandScheduler);
  await safeStop('EventSub reconciliation', stopEventSubReconciliation);
  await safeStop('EventSub', () => stopEventSub());
  await safeStop('Twitch monitor', stopTwitchMonitor);
  await safeStop('Twitch bot', stopTwitchBot);
  await safeStop('Discord bot', () => stopDiscordBot());
  await safeStop('audio player', () => disconnect());
  await closePool();
  process.exit(0);
}

process.on('SIGINT',  () => { shutdown('SIGINT').catch((err: unknown)  => { log.error('Shutdown error:', err); process.exit(1); }); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch((err: unknown) => { log.error('Shutdown error:', err); process.exit(1); }); });

// Without these, a rejection or throw originating from inside a third-party library's own
// internals (discord.js, @twurple/chat, mysql2, ws) rather than the app's own promise chains would go
// fully unhandled and silently kill the process — there's no supervisor (pm2/systemd) to restart
// it, so we log loudly and exit deliberately instead, making the failure visible and diagnosable.

/**
 * Wraps a non-`Error` rejection/throw value in an `Error`, since winston (no `format.splat()`)
 * silently drops a non-object second argument — a bare string reason would otherwise vanish
 * from the log. `Error` values are returned unchanged.
 * @param value - The rejection reason or thrown value.
 * @returns `value` itself if it's an `Error`, otherwise a new `Error` of its string form.
 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Logs an unhandled promise rejection and exits, rather than letting Node's default
 * (process termination without a clean log line) or silently continuing.
 * @param reason - The rejection reason (typically an `Error`, but not guaranteed to be).
 * @returns Never returns — always calls `process.exit(1)`.
 */
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection:', toError(reason));
  process.exit(1);
});

/**
 * Logs an uncaught synchronous exception and exits — continuing after `uncaughtException` risks
 * running with corrupted state, so this deliberately does not attempt to recover.
 * @param err - The uncaught error.
 * @returns Never returns — always calls `process.exit(1)`.
 */
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', toError(err));
  process.exit(1);
});

/**
 * Boots the bot: verifies DB connectivity, wires every Twitch/EventSub runtime callback,
 * loads the guild registry, then starts the Discord bot, Twitch bot, web panel, and
 * schedulers, in that order (see the Startup Sequence section of `CLAUDE.md`), finishing with
 * an owner DM (see `ownerAlerts.ts`'s `announceStartup`) confirming the bot is back online —
 * paired with `shutdown()`'s `announceShutdown` DM. That DM waits (up to
 * {@link DISCORD_READY_FOR_OWNER_DM_TIMEOUT_MS}) for Discord to actually be ready, since
 * `startDiscordBot()` itself doesn't block on it.
 * @returns Resolves once every component has started; rejects (and exits the process,
 *   via the `.catch` below) if DB connectivity, the `redemption_handled` migration check, or the
 *   guild registry load fails. A `startTwitchBot()` failure is logged and startup continues.
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

  // Every channel-point redemption reads and writes redemption_handled; without it each one would
  // fail and be retried until the table appears. Fail loudly instead of running degraded.
  let ledgerReady = false;
  try {
    ledgerReady = await isRedemptionLedgerReady();
  } catch (err) {
    log.error('Cannot check the redemption_handled table:', err);
    process.exit(1);
  }
  if (!ledgerReady) {
    log.error('Database table redemption_handled is missing — apply migrations/redemption_handled.sql, then restart.');
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
  registerFollowageRuntime({ send: sayInChannel });
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
    // Alerts can fire before Discord finishes connecting (e.g. startTwitchBot() reporting a
    // missing bot token), so wait for clientReady rather than dropping them.
    waitUntilReady: () => waitForDiscordReady(DISCORD_READY_FOR_OWNER_DM_TIMEOUT_MS),
    send: async (discordId, message) => {
      const client = getDiscordClient();
      if (!client) throw new Error('Discord client is not ready');
      const user = await client.users.fetch(discordId);
      await user.send(message);
    },
  });
  await primeOwnerAlertBaseline();
  startOwnerAlertWatcher();
  // Don't let a Twitch chat failure (e.g. a revoked bot token or an IRC outage) abort startup —
  // the web panel must still come up so the owner can reconnect the bot via /admin/bot-auth.
  try {
    await startTwitchBot();
  } catch (err) {
    log.error('Twitch bot failed to start — continuing without Twitch chat:', err);
  }
  startWebPanel();
  startChannelReconciliationPoll();
  startCounterScheduler();
  startRewardPricingScheduler();
  startTimerCommandScheduler();
  startDbHealthCheck();

  startTwitchMonitor().catch((err: unknown) => log.error('TwitchMonitor startup error:', err));
  startEventSub();
  startEventSubReconciliation();

  // Never throws — waits for Discord via the owner-alert runtime's waitUntilReady, and logs and
  // skips the DM if it never becomes ready.
  await announceStartup();
}

main().catch((err: unknown) => {
  log.error('Fatal startup error:', err);
  process.exit(1);
});
