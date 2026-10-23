// Throttled logging for discord.js `shardError` events, so a burst of gateway retries during a
// Discord-side outage produces one log line per shard per interval. Owner DMs for a gateway outage
// come from the health watcher in `ownerAlerts.ts` instead (via the `discord` component), whose
// grace period keeps a blip that recovers within a minute from paging anyone.
import { createLogger } from '../shared/logger';

const log = createLogger('Discord');

/** How often a given shard's gateway connection errors are actually logged — see {@link logShardError}. */
const SHARD_ERROR_LOG_INTERVAL_MS = 60_000;

/** Per-shard state for {@link logShardError}: when it last actually logged, and how many errors it has swallowed since. */
const shardErrorLogState = new Map<number, { lastLoggedAt: number; suppressedCount: number }>();

/**
 * Logs a `shardError` at `error`, throttled to at most one line per shard per {@link SHARD_ERROR_LOG_INTERVAL_MS}. During a Discord-side gateway hiccup (e.g.
 * repeated `Unexpected server response: 503`), discord.js's automatic reconnect can retry —
 * and this event can fire — many times a second; logging (and alerting on) every one of those
 * verbatim has filled multiple log files in a single incident without adding any information
 * discord.js's own retry wasn't already handling. Errors swallowed during the throttle window
 * are counted and folded into the next line that does get logged. Logged as an error (unlike
 * 'shardReconnecting') so the cause is on record, but it doesn't DM the owner directly: the
 * health watcher does that once the outage outlasts its grace period, and pairs it with a
 * "recovered" DM.
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
  shardErrorLogState.set(shardId, { lastLoggedAt: now, suppressedCount: 0 });
}
