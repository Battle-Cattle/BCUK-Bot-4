import { createMutationQueue } from '../shared/mutationQueue';

/**
 * Minimum spacing enforced between two outgoing chat sends to a channel where the bot is *not*
 * a moderator. Twitch's standard chat rate limit there is 20 messages per 30 seconds per
 * channel — 1.5s spacing keeps it comfortably under that.
 */
export const NON_MOD_MIN_SEND_INTERVAL_MS = 1_500;

/**
 * Minimum spacing enforced between two outgoing chat sends to a channel where the bot *is* a
 * moderator (or the broadcaster). Twitch's elevated chat rate limit there is 100 messages per
 * 30 seconds per channel — 300ms spacing keeps it comfortably under that.
 */
export const MOD_MIN_SEND_INTERVAL_MS = 300;

// Per-channel FIFO ordering — sends to the same channel are serialized and spaced out; sends
// to different channels run fully independently and are never delayed by each other.
const channelQueue = createMutationQueue<string>();

// Tracks the next scheduled send slot per channel, keyed off the schedule itself rather than
// actual send completion time, so a slow/failed send doesn't shrink the spacing of the sends
// queued behind it.
const nextAllowedAt = new Map<string, number>();

/** Resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Runs `send` for `channel`, delaying it as needed so sends to the same channel never happen
 * closer together than `minIntervalMs`. Queued per channel — a call returns only once it's
 * actually run (send succeeded or threw), and calls for the same channel always run in the
 * order they were enqueued. Callers pick `minIntervalMs` per call (e.g. based on the bot's
 * current moderator status in that channel — see {@link NON_MOD_MIN_SEND_INTERVAL_MS} and
 * {@link MOD_MIN_SEND_INTERVAL_MS}), so a status change takes effect from the next send onward.
 * @param channel - Normalized Twitch channel name the send is targeting.
 * @param send - Performs the actual send. Rejecting doesn't affect the timing of later queued sends.
 * @param minIntervalMs - Minimum spacing to enforce after this send before the next one for `channel`.
 */
export async function throttledChannelSend(channel: string, send: () => Promise<void>, minIntervalMs: number): Promise<void> {
  await channelQueue.run(channel, async () => {
    const now = Date.now();
    const scheduledAt = Math.max(now, nextAllowedAt.get(channel) ?? 0);
    if (scheduledAt > now) await delay(scheduledAt - now);
    nextAllowedAt.set(channel, scheduledAt + minIntervalMs);
    await send();
  });
}

/** Test-only: clears all per-channel send-timing state so each test starts from a clean slate. */
export function __resetTwitchSendQueueForTests(): void {
  nextAllowedAt.clear();
}
