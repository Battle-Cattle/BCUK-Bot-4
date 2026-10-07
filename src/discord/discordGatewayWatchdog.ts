// Fallback for a stuck discord.js gateway reconnect loop. discord.js's own WebSocketManager is
// documented (see registerConnectionHandlers's docstring in `discordBot.ts`) as retrying every
// recoverable gateway disconnect on its own, forever, without our help.
import { createLogger } from '../shared/logger';
import { sendOwnerAlert } from './ownerAlerts';

const log = createLogger('Discord');

// In practice that retry loop can itself get stuck — observed in production as a run of
// 'shardReconnecting'/'shardError' events during a sustained `Unexpected server response: 503`
// incident, followed by total silence: no further 'shardReconnecting', 'shardError', 'shardReady'
// or 'shardDisconnect' for many minutes, well beyond discord.js's own reconnect backoff (which
// caps out well under a minute). Because that failure mode never reaches 'shardDisconnect' (no
// close code — the socket never even opened), the self-heal in registerConnectionHandlers never
// fires either, leaving the process alive-but-permanently-disconnected until someone notices and
// restarts it manually. This watchdog is the fallback: if no shard activity of any kind is seen
// for GATEWAY_STALL_THRESHOLD_MS while not fully connected, force a fresh login exactly as
// 'shardDisconnect' does.

/** How often {@link checkGatewayStall} polls for a stuck gateway reconnect loop. */
const GATEWAY_STALL_CHECK_INTERVAL_MS = 30_000;

/**
 * How long the gateway may go without any shard activity (reconnect attempt, error, ready,
 * resume) before {@link checkGatewayStall} treats discord.js's own retry loop as stuck and forces
 * a fresh login. Well above discord.js's own reconnect backoff ceiling, so a slow-but-still-live
 * retry cycle never false-positives.
 */
const GATEWAY_STALL_THRESHOLD_MS = 120_000;

let lastShardActivityAt = Date.now();
let gatewayWatchdogTimer: NodeJS.Timeout | null = null;

/**
 * Tracks live gateway connectivity for {@link checkGatewayStall} — distinct from
 * `getDiscordClient()` returning non-null, which only means a `Client` was *at some point*
 * promoted to ready and stays in the store until `stopDiscordBot()`/`shardDisconnect` explicitly
 * clear it. A `shardError` on an already-ready client does *not* clear it, so gating the watchdog
 * on client existence would silently defeat it for exactly the incident it exists to catch: a
 * previously-ready shard that errors out and then goes silent. Mirrors `recordDiscordConnected`'s
 * true/false transitions one-for-one, kept separately so this module's stall detection doesn't
 * depend on `healthStore`'s snapshot shape.
 */
let gatewayConnected = false;

/**
 * Set from the moment {@link checkGatewayStall} forces a recovery, and normally cleared as soon as
 * that recovery's replacement `login()` call settles (see `registerClientReadyHandler` in `discordBot.ts` and
 * the login failure handler in `startDiscordBot`) — one way (success) or the other (failure,
 * which hands off to the ordinary backoff retry). Guards against compounding restarts: without it,
 * a replacement login that never settles would still leave `lastShardActivityAt` stale once its
 * stall window re-elapses, so the next tick would tear it down and start yet another one on top of
 * it, indefinitely, with no backoff — risking Discord's identify rate limits. While
 * {@link isWatchdogRecoveryPending} reads true, {@link checkGatewayStall} stands down and waits for
 * the outstanding attempt instead of piling on another.
 *
 * discord.js's own `Client.login()` can resolve once the socket handshake starts, *before*
 * `clientReady` — so a replacement login can settle (successfully, from `login()`'s point of view)
 * without ever firing `clientReady` or rejecting, if the shard then hangs before reaching ready.
 * Neither of this guard's two clear sites would ever run in that case, so it's tracked as a
 * timestamp rather than a plain boolean and treated as cleared once
 * {@link WATCHDOG_RECOVERY_TIMEOUT_MS} has elapsed — bounding the worst case to "eventually retries
 * again" instead of "permanently disabled for the rest of the process's life".
 */
let watchdogRecoveryPendingSince: number | null = null;

/**
 * How long {@link watchdogRecoveryPendingSince} is honored before {@link isWatchdogRecoveryPending}
 * treats it as expired regardless of whether the recovery's login ever explicitly settled. Minutes,
 * not seconds — comfortably longer than any legitimate identify/ready handshake — so this only ever
 * kicks in for the pathological case the docstring above describes.
 */
const WATCHDOG_RECOVERY_TIMEOUT_MS = 5 * 60_000;

/** Whether a watchdog-triggered recovery is still within its bounded pending window (see {@link watchdogRecoveryPendingSince}). */
function isWatchdogRecoveryPending(): boolean {
  return watchdogRecoveryPendingSince !== null && Date.now() - watchdogRecoveryPendingSince < WATCHDOG_RECOVERY_TIMEOUT_MS;
}

/** Stamps `lastShardActivityAt` with the current time — called from every shard lifecycle event. */
export function recordShardActivity(): void {
  lastShardActivityAt = Date.now();
}

/**
 * Polled every {@link GATEWAY_STALL_CHECK_INTERVAL_MS}: if the gateway isn't currently connected
 * (see {@link gatewayConnected}), no recovery from a previous stall is still outstanding (see
 * {@link isWatchdogRecoveryPending}), and no shard activity has been recorded for
 * {@link GATEWAY_STALL_THRESHOLD_MS}, discord.js's own reconnect loop is presumed stuck. Logs, DMs
 * the owner, and forces a fresh login the same way `shardDisconnect` does (including tearing down
 * orphaned voice connections first).
 *
 * Skipped while a login-failure backoff retry is pending (`hooks.isReconnectPending`): that backoff
 * (up to `RECONNECT_MAX_DELAY_MS` in `discordBot.ts`) can legitimately outlast the stall threshold, and forcing a login
 * here would cancel it, defeat the backoff and re-alert the owner on every check.
 */
function checkGatewayStall(): void {
  if (!hooks || gatewayConnected || isWatchdogRecoveryPending() || hooks.isReconnectPending()) return;
  const stalledForMs = Date.now() - lastShardActivityAt;
  if (stalledForMs < GATEWAY_STALL_THRESHOLD_MS) return;
  const stalledForSec = Math.round(stalledForMs / 1000);
  log.error(`No Discord gateway activity for ${stalledForSec}s — the reconnect loop appears stuck; forcing a fresh login.`);
  void sendOwnerAlert(`🔴 Discord gateway reconnect appears stuck (no activity for ${stalledForSec}s) — forcing a fresh login.`);
  hooks.stop();
  // Set *after* hooks.stop() — stopDiscordBot() unconditionally clears this, so an intentional stop
  // overlapping a previous recovery never leaves it stuck pending — and before hooks.start(),
  // with nothing async in between, so this recovery's own guard can't be clobbered by that clear.
  watchdogRecoveryPendingSince = Date.now();
  hooks.start();
}

/** What the watchdog needs from the bot to decide whether, and how, to force a fresh login. */
export interface GatewayWatchdogHooks {
  /** Whether a login-failure backoff retry is already scheduled (the watchdog stands down). */
  isReconnectPending: () => boolean;
  /** Tears the current client down (voice connections included), as `shardDisconnect` does. */
  stop: () => void;
  /** Starts a fresh login. */
  start: () => void;
}

let hooks: GatewayWatchdogHooks | null = null;

/**
 * Starts the gateway stall watchdog interval, if not already running. Unref'd so it never blocks
 * process exit.
 * @param watchdogHooks - Bot callbacks used to check for a pending backoff retry and to force a relogin.
 */
export function startGatewayWatchdog(watchdogHooks: GatewayWatchdogHooks): void {
  hooks = watchdogHooks;
  if (gatewayWatchdogTimer) return;
  gatewayWatchdogTimer = setInterval(checkGatewayStall, GATEWAY_STALL_CHECK_INTERVAL_MS).unref();
}

/** Stops and clears the gateway stall watchdog interval, if running. */
export function stopGatewayWatchdog(): void {
  if (gatewayWatchdogTimer) {
    clearInterval(gatewayWatchdogTimer);
    gatewayWatchdogTimer = null;
  }
}

/**
 * Records whether the gateway is currently connected (see {@link gatewayConnected}).
 * @param connected - True on `clientReady`/`shardReady`/`shardResume`, false on errors and disconnects.
 */
export function setGatewayConnected(connected: boolean): void {
  gatewayConnected = connected;
}

/** Clears an outstanding watchdog recovery once its login settles, or on any stop (see {@link watchdogRecoveryPendingSince}). */
export function clearWatchdogRecovery(): void {
  watchdogRecoveryPendingSince = null;
}
