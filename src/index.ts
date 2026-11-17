import 'mediaplex'; // Must be imported first to register as Opus provider
import { getPool, closePool, pingDb, runMigrations, reencryptStoredTokens } from './db';
import { recordDbPing } from './shared/healthStore';
import { registerOwnerAlertRuntime, announceShutdown, announceStartup } from './discord/ownerAlerts';
import { primeOwnerAlertBaseline, startOwnerAlertWatcher, stopOwnerAlertWatcher } from './discord/ownerAlertWatcher';
import { startTwitchBot, stopTwitchBot, sayInChannel } from './twitch/twitchBot';
import { getActiveChannels, getActiveChannelUserIds, setChannelJoinedHook } from './twitch/twitchChannelMembership';
import { startChannelReconciliationPoll, stopChannelReconciliationPoll } from './twitch/twitchChannelReconciliationPoll';
import { startDiscordBot, stopDiscordBot, waitForDiscordReady } from './discord/discordBot';
import { getDiscordClient } from './discord/discordClientStore';
import { reloadGuildRegistry } from './discord/guildRegistry';
import { resolveGuildIdForDiscordId } from './discord/voicePresence';
import { registerTwitchGuildResolutionRuntime } from './twitch/twitchGuildResolutionRuntime';
import { startTwitchMonitor, stopTwitchMonitor, getMultiTwitchDataForChannel } from './twitch/monitor/twitchMonitor';
import { startEventSub, stopEventSub, reloadEventSubSubscriptions } from './twitch/eventsub/twitchEventSub';
import { startEventSubReconciliation, stopEventSubReconciliation } from './twitch/eventsub/twitchEventSubReconciliation';
import { startWebPanel, stopWebPanel } from './web/server';
import { stopWebmTranscodes } from './web/routes/overlayVideoTranscode';
import { startOverlayOrphanSweep, stopOverlayOrphanSweep } from './web/routes/overlayOrphanSweep';
import { disconnect } from './audio/audioPlayer';
import { registerTwitchChatRuntime } from './commands/customCommandHandler';
import { registerCounterTwitchRuntime } from './commands/counterHandler';
import { registerPointsTwitchRuntime } from './commands/pointsHandler';
import { registerGambleTwitchRuntime } from './commands/gambleHandler';
import { registerRaffleTwitchRuntime, stopAllRaffles } from './commands/raffle/raffleHandler';
import { registerMultiTwitchRuntime } from './commands/multiCommandHandler';
import { registerShoutoutRuntime } from './commands/shoutoutHandler';
import { registerCountdownTwitchRuntime } from './commands/countdownHandler';
import { registerFollowageRuntime } from './commands/followageHandler';
import { registerAdvancedCommandRuntime } from './commands/advancedCommands/advancedCommandRuntime';
import { sweepPendingAdvancedCommandUsage } from './commands/advancedCommands/advancedCommandRefunds';
import { sweepPendingRedemptionAcks } from './twitch/eventsub/twitchEventSubRedemptionAcks';
import {
  registerEventSubOverlayRuntime, registerEventSubTwitchRuntime, registerEventSubCompanionRuntime,
  registerEventSubAlertRuntime, registerEventSubDashboardRuntime, registerEventSubReloadRuntime,
} from './twitch/eventsub/twitchEventSubRuntime';
import { pushOverlayEvent } from './web/routes/overlaySource';
import { pushCompanionEvent, hasCompanionConnection } from './web/routes/companionEvents';
import { pushAlertEvent } from './web/routes/alertsOverlaySource';
import { pushPricingUpdate } from './web/routes/channelPointsEvents';
import { pushDashboardEvent } from './web/routes/dashboardEvents';
import { startCounterScheduler, stopCounterScheduler } from './commands/counterScheduler';
import { startRewardPricingScheduler, stopRewardPricingScheduler } from './twitch/pricing/rewardPricingScheduler';
import { registerRewardPricingRuntime } from './twitch/pricing/rewardPricingService';
import { startTimerCommandScheduler, stopTimerCommandScheduler, registerTimerCommandsRuntime } from './twitch/timers/timerCommandScheduler';
import { createLogger, flushLogs } from './shared/logger';
import { withTimeout } from './shared/withTimeout';
import { startEventLoopMonitor, stopEventLoopMonitor } from './shared/eventLoopMonitor';
import { startDiskSpaceMonitor, stopDiskSpaceMonitor } from './shared/diskSpaceMonitor';
import { restoreDebugLogging, startDebugLogPruning, stopDebugLogPruning } from './shared/debugLogging';

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
/**
 * How long shutdown waits for the owner's "shutting down" DM. Together with the web panel's 10s
 * drain (`WEB_DRAIN_TIMEOUT_MS` in `src/web/server.ts`), the rest of teardown and the 2s log flush,
 * this keeps shutdown inside `TimeoutStopSec=30` (deploy/bcuk-bot.service).
 */
const SHUTDOWN_ANNOUNCEMENT_TIMEOUT_MS = 5_000;
/**
 * Longest a shutdown may take before it gives up on the remaining teardown and exits 1 (after the
 * log flush), so a hung step (a bot or EventSub disconnect, the pool close) is logged and the exit
 * still comes from us, not from systemd's SIGKILL at `TimeoutStopSec=30`, which would leave no log
 * line. Leaves room for the 2s flush and a margin under 30s.
 */
const SHUTDOWN_DEADLINE_MS = 25_000;

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

/**
 * Exits the process once the log files hold everything logged so far (see `flushLogs` in
 * `src/shared/logger.ts`, which gives up after a couple of seconds). Without the wait, the line
 * explaining a fatal exit would usually be lost from `error-*.log`/`combined-*.log`, reaching only
 * the console. Every exit goes through here: 1 for a failure, 0 only after a deliberate shutdown.
 * A failure reported while an exit(0) is still waiting turns it into an exit(1).
 * @param code - The process exit code.
 * @returns Never resolves: the process exits.
 */
async function exitProcess(code: 0 | 1): Promise<never> {
  // Shared, so a failure reported while a deliberate exit(0) is still flushing still exits 1.
  exitCode = Math.max(exitCode ?? 0, code) as 0 | 1;
  await flushLogs();
  return process.exit(exitCode);
}

/** The code {@link exitProcess} will exit with: the highest any caller asked for. */
let exitCode: 0 | 1 | undefined;

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
 * `ownerAlertWatcher.ts`'s `stopOwnerAlertWatcher` and `ownerAlerts.ts`'s `announceShutdown`) before anything actually
 * disconnects. Each teardown step is isolated via {@link safeStop} so a failure in one component
 * (e.g. the Twitch monitor) can't skip the rest — `closePool()` and the exit(0) always run.
 * If the teardown is still running after {@link SHUTDOWN_DEADLINE_MS}, it logs that and exits 1.
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
  // Exits 1 if teardown hangs. Not unref'd: a step stuck on a promise with nothing else keeping the
  // event loop alive would otherwise let the process end silently instead of logging why.
  const deadline = setTimeout(() => {
    log.error(`Shutdown still running after ${SHUTDOWN_DEADLINE_MS}ms; exiting without finishing teardown.`);
    void exitProcess(1);
  }, SHUTDOWN_DEADLINE_MS);
  try {
    await teardown();
  } finally {
    clearTimeout(deadline);
  }
  await exitProcess(0);
}

/**
 * The teardown steps of {@link shutdown}, in order: owner alerts, the web panel, transcodes and
 * schedulers, EventSub and the monitor, the bots, audio, then the DB pool.
 * @returns Resolves once every step has run; a failing step is logged and skipped (see {@link safeStop}).
 */
async function teardown(): Promise<void> {
  // Before anything else — every stop* call below disconnects a component (Twitch chat, EventSub,
  // etc.), and none of that is a real outage the owner needs a DM about.
  stopOwnerAlertWatcher();
  // ...then announce the shutdown itself, while the Discord client this DM needs is still up —
  // stopDiscordBot() below tears it down.
  // Bounded, so a Discord client that's reconnecting can't eat the time the web drain and the
  // rest of shutdown need inside the unit's TimeoutStopSec.
  await safeStop('owner alert shutdown announcement', () =>
    withTimeout(announceShutdown(), SHUTDOWN_ANNOUNCEMENT_TIMEOUT_MS, 'Shutdown announcement'));
  // Stop taking web requests before the components they'd act on start disconnecting.
  await safeStop('web panel', stopWebPanel);
  // With no more uploads coming in, kill any overlay video conversion still running, so an ffmpeg
  // child isn't left encoding after the bot exits.
  stopWebmTranscodes();
  stopOverlayOrphanSweep();
  stopDbHealthCheck();
  stopEventLoopMonitor();
  stopDiskSpaceMonitor();
  stopDebugLogPruning();
  stopCounterScheduler();
  await safeStop('raffles', stopAllRaffles);
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
  log.info('Shutdown complete.');
}

process.on('SIGINT',  () => { shutdown('SIGINT').catch((err: unknown)  => { log.error('Shutdown error:', err); void exitProcess(1); }); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch((err: unknown) => { log.error('Shutdown error:', err); void exitProcess(1); }); });

// Without these, a rejection or throw originating from inside a third-party library's own
// internals (discord.js, @twurple/chat, mysql2, ws) rather than the app's own promise chains would go
// fully unhandled and kill the process without a trace. Instead we log it loudly and exit 1, so the
// failure is diagnosable and systemd (deploy/bcuk-bot.service, Restart=on-failure) restarts the
// bot from a clean state rather than letting it limp on.

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
 */
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection:', toError(reason));
  void exitProcess(1);
});

/**
 * Logs an uncaught synchronous exception and exits — continuing after `uncaughtException` risks
 * running with corrupted state, so this deliberately does not attempt to recover. The exit waits
 * only for the log files to be written (at most a couple of seconds).
 * @param err - The uncaught error.
 */
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', toError(err));
  void exitProcess(1);
});

/**
 * Registers every Twitch/EventSub runtime callback (`src/shared/runtimeRegistry.ts` slots) used
 * by command handlers and EventSub effects, so they can send/push without importing this file
 * and creating a circular dependency (see "New Command Handler Pattern" in CLAUDE.md). Must run
 * before `startTwitchBot()`/`startDiscordBot()`, since the first incoming message could already
 * need one of these.
 */
function registerTwitchRuntimes(): void {
  registerTwitchChatRuntime({
    send: sayInChannel,
    getActiveChannels,
    getLoginUserIds: getActiveChannelUserIds,
    getMultiTwitchDataForChannel,
  });
  registerCounterTwitchRuntime({ send: sayInChannel });
  registerPointsTwitchRuntime({ send: sayInChannel });
  registerGambleTwitchRuntime({ send: sayInChannel });
  registerRaffleTwitchRuntime({ send: sayInChannel, getLoginUserIds: getActiveChannelUserIds });
  registerMultiTwitchRuntime({ send: sayInChannel, getActiveChannels, getLoginUserIds: getActiveChannelUserIds });
  registerShoutoutRuntime({ send: sayInChannel });
  registerCountdownTwitchRuntime({ send: sayInChannel });
  registerFollowageRuntime({ send: sayInChannel });
  registerAdvancedCommandRuntime({ send: sayInChannel, hasCompanionConnection });
  registerEventSubOverlayRuntime({ pushOverlayEvent });
  registerEventSubCompanionRuntime({ pushCompanionEvent, hasCompanionConnection });
  registerEventSubAlertRuntime({ pushAlertEvent });
  registerEventSubDashboardRuntime({ pushDashboardEvent });
  registerEventSubTwitchRuntime({ send: sayInChannel });
  registerEventSubReloadRuntime({ triggerReload: reloadEventSubSubscriptions });
  registerRewardPricingRuntime({ pushPricingUpdate });
  registerTimerCommandsRuntime({ send: sayInChannel, getLoginUserIds: getActiveChannelUserIds });
  registerTwitchGuildResolutionRuntime({ resolveGuildIdForDiscordId });
}

/**
 * Refunds advanced command uses and channel-point redemptions a restart left waiting for a
 * companion acknowledgement (their timers lived in the old process). Runs before Twitch chat and
 * EventSub start, so it can't catch a new use or redemption; a failure is logged, not fatal — the
 * rows stay pending for the next start.
 * @returns Resolves once both sweeps have been attempted.
 */
async function sweepPendingCompanionAcks(): Promise<void> {
  try {
    await sweepPendingAdvancedCommandUsage();
  } catch (err) {
    log.error('Failed to refund pending advanced command uses:', err);
  }
  try {
    await sweepPendingRedemptionAcks();
  } catch (err) {
    log.error('Failed to refund redemptions pending companion confirmation:', err);
  }
}

/**
 * Boots the bot: restores a debug logging window saved before the restart (and starts pruning old
 * debug log files), so the window also captures the rest of startup; verifies DB connectivity, wires every Twitch/EventSub runtime callback,
 * loads the guild registry, then starts the Discord bot, Twitch bot, web panel, and
 * schedulers, in that order (see the Startup Sequence section of `CLAUDE.md`), finishing with
 * an owner DM (see `ownerAlerts.ts`'s `announceStartup`) confirming the bot is back online —
 * paired with `shutdown()`'s `announceShutdown` DM. That DM waits (up to
 * {@link DISCORD_READY_FOR_OWNER_DM_TIMEOUT_MS}) for Discord to actually be ready, since
 * `startDiscordBot()` itself doesn't block on it.
 * @returns Resolves once every component has started; rejects (and exits the process,
 *   via the `.catch` below) if DB connectivity, the schema migrations, or the
 *   guild registry load fails. A `startTwitchBot()` failure is logged and startup continues.
 */
async function main(): Promise<void> {
  log.info('Starting BCUK Bot 4...');
  // First, so a debug window (switched on from the health page or `npm run deploy debug`) also
  // captures the rest of startup.
  await restoreDebugLogging();
  startDebugLogPruning();

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
    return exitProcess(1);
  }

  // Bring the schema up to date before anything reads it. A failed migration stops startup rather
  // than running against a half-migrated database.
  try {
    await runMigrations();
  } catch (err) {
    log.error('Database migration failed:', err);
    return exitProcess(1);
  }

  // Rewrite any OAuth token not yet under the active EVENTSUB_TOKEN_SECRET (legacy tokens, or ones
  // from before a key rotation) before anything reads them. Not fatal: until it succeeds, tokens
  // under the previous key still decrypt while EVENTSUB_TOKEN_SECRET_PREVIOUS is set.
  try {
    await reencryptStoredTokens();
  } catch (err) {
    log.warn('Re-encrypting stored tokens under the active key failed; will retry on the next start:', err);
  }

  // Wire Twitch send/channel helpers before the bot connects so the first
  // message can already use the execute path (functions capture live state).
  registerTwitchRuntimes();

  // Load the guild registry before the Discord client connects so the
  // messageCreate gate recognises registered guilds from the first message.
  try {
    await reloadGuildRegistry();
  } catch (err) {
    log.error('Cannot load guild registry:', err);
    return exitProcess(1);
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
  await sweepPendingCompanionAcks();
  // Don't let a Twitch chat failure (e.g. a revoked bot token or an IRC outage) abort startup —
  // the web panel must still come up so the owner can reconnect the bot via /admin/bot-auth.
  try {
    await startTwitchBot();
  } catch (err) {
    log.error('Twitch bot failed to start — continuing without Twitch chat:', err);
  }
  // A listen failure (e.g. EADDRINUSE) is fatal: the likely cause is a previous bot process that
  // never exited, and this one carrying on beside it would break the single-instance assumption.
  try {
    await startWebPanel();
  } catch (err) {
    log.error('Web panel failed to start:', err);
    return exitProcess(1);
  }
  startChannelReconciliationPoll();
  startCounterScheduler();
  startRewardPricingScheduler();
  startTimerCommandScheduler();
  startOverlayOrphanSweep();
  startDbHealthCheck();
  startEventLoopMonitor();
  startDiskSpaceMonitor();

  startTwitchMonitor().catch((err: unknown) => log.error('TwitchMonitor startup error:', err));
  startEventSub();
  startEventSubReconciliation();

  // Never throws — waits for Discord via the owner-alert runtime's waitUntilReady, and logs and
  // skips the DM if it never becomes ready.
  await announceStartup();
}

main().catch((err: unknown) => {
  log.error('Fatal startup error:', err);
  void exitProcess(1);
});
