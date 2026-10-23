// Throttled logging/alerting for discord.js `shardError` events, so a burst of gateway retries
// during a Discord-side outage produces one line (and one owner DM) per shard per interval, plus
// a matching "reconnected" DM once the shard recovers, so the owner isn't left with only the red one.
import { createLogger } from '../shared/logger';
import { sendOwnerAlert } from './ownerAlerts';

const log = createLogger('Discord');

/** How often a given shard's gateway connection errors are actually logged — see {@link logShardError}. */
const SHARD_ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Per-shard state for {@link logShardError}: when it last actually logged, how many errors it has
 * swallowed since, and when the current outage's first error DM went out (for {@link logShardRecovered}).
 * An entry exists only while the shard has an outage the owner was told about.
 */
const shardErrorLogState = new Map<number, { lastLoggedAt: number; suppressedCount: number; outageStartedAt: number }>();

/**
 * When the gateway stall watchdog last DMed the owner about a stuck reconnect loop (see
 * {@link markGatewayStallAlerted}), or null if it hasn't since the last recovery. Not per-shard:
 * the watchdog watches the whole (single-shard) client.
 */
let stallAlertedAt: number | null = null;

/**
 * Logs a `shardError` at `error` and DMs the owner, throttled to at most one line/DM per
 * shard per {@link SHARD_ERROR_LOG_INTERVAL_MS}. During a Discord-side gateway hiccup (e.g.
 * repeated `Unexpected server response: 503`), discord.js's automatic reconnect can retry —
 * and this event can fire — many times a second; logging (and alerting on) every one of those
 * verbatim has filled multiple log files in a single incident without adding any information
 * discord.js's own retry wasn't already handling. Errors swallowed during the throttle window
 * are counted and folded into the next line/DM that does get sent. Still worth surfacing as an
 * error (unlike 'shardReconnecting') because a shard that keeps erroring is a real, ongoing
 * connectivity problem worth a human looking at, even though discord.js itself will keep
 * retrying without help. {@link logShardRecovered} sends the matching "reconnected" DM.
 * @param shardId - The shard that reported the error.
 * @param err - The gateway connection error.
 */
export function logShardError(shardId: number, err: Error): void {
  const now = Date.now();
  const state = shardErrorLogState.get(shardId);
  if (state && now - state.lastLoggedAt < SHARD_ERROR_LOG_INTERVAL_MS) {
    state.suppressedCount++;
    return;
  }
  const suppressed = state?.suppressedCount ?? 0;
  const suffix = suppressed > 0 ? ` (${suppressed} more suppressed in the last ${SHARD_ERROR_LOG_INTERVAL_MS / 1000}s)` : '';
  log.error(`Shard ${shardId} gateway connection error:${suffix}`, err);
  shardErrorLogState.set(shardId, { lastLoggedAt: now, suppressedCount: 0, outageStartedAt: state?.outageStartedAt ?? now });
  void sendOwnerAlert(`🔴 Shard ${shardId} gateway connection error${suffix}: ${err.message}`);
}

/** Records that the gateway stall watchdog has DMed the owner, so the next recovery is announced too (see {@link logShardRecovered}). */
export function markGatewayStallAlerted(): void {
  stallAlertedAt ??= Date.now();
}

/**
 * Called when a shard is connected again (`shardReady`/`shardResume`). If the owner was DMed about
 * this outage — by {@link logShardError} or the stall watchdog — logs the recovery and DMs a
 * matching "reconnected" alert; a reconnect nobody was alerted about stays silent. Also resets the
 * shard's throttle, so the first error of the next outage is alerted on straight away.
 * @param shardId - The shard that is connected again.
 */
export function logShardRecovered(shardId: number): void {
  const outageStartedAt = shardErrorLogState.get(shardId)?.outageStartedAt ?? stallAlertedAt;
  shardErrorLogState.delete(shardId);
  stallAlertedAt = null;
  if (outageStartedAt === null) return;
  const downForSec = Math.round((Date.now() - outageStartedAt) / 1000);
  log.info(`Shard ${shardId} reconnected to the gateway (${downForSec}s after the first alert).`);
  void sendOwnerAlert(`🟢 Shard ${shardId} reconnected to the Discord gateway (${downForSec}s after the first alert).`);
}
