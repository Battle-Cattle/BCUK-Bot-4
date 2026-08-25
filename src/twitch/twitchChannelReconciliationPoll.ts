import { createLogger } from '../shared/logger';
import { reconcileJoinedChannels } from './twitchChannelMembership';

const log = createLogger('Twitch');

/**
 * How often {@link startChannelReconciliationPoll} re-runs `reconcileJoinedChannels()` in the
 * background. It otherwise only runs once, from `onConnected` after a successful (re)connect — if
 * a channel's join in that pass fails (e.g. a timeout, or racing the underlying Twurple client's
 * own join-rate-limiter being paused/cleared by a near-simultaneous disconnect), nothing else ever
 * retries it: the channel is left parted, silently, until the next full reconnect. This poll exists
 * purely to catch and self-heal that case (mirrors `twitchEventSubReconciliation.ts`'s periodic-poll
 * pattern for the same class of problem).
 */
const RECONCILE_POLL_INTERVAL_MS = 60_000;

let reconcileTickTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic channel-membership reconciliation interval (see
 * {@link RECONCILE_POLL_INTERVAL_MS}). Call once at bot startup, after Twitch chat has connected.
 * No-ops if already started, so a second call can't leak the original interval handle.
 */
export function startChannelReconciliationPoll(): void {
  if (reconcileTickTimer) return;
  reconcileTickTimer = setInterval(() => {
    reconcileJoinedChannels().catch((err) => log.error('Periodic channel reconciliation error:', err));
  }, RECONCILE_POLL_INTERVAL_MS);
  log.info(`Started periodic channel-membership reconciliation every ${RECONCILE_POLL_INTERVAL_MS / 1000}s`);
}

/** Stops the periodic channel-membership reconciliation interval. */
export function stopChannelReconciliationPoll(): void {
  if (reconcileTickTimer) { clearInterval(reconcileTickTimer); reconcileTickTimer = null; }
}
