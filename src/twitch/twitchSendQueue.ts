import { createMutationQueue } from '../shared/mutationQueue';

/**
 * Minimum spacing enforced between two outgoing chat sends to the same channel. Twitch's
 * standard (non-moderator) chat rate limit is 20 messages per 30 seconds per channel — 1.5s
 * spacing keeps every channel comfortably under that regardless of whether the bot happens to
 * be a moderator there. Shared by every feature that posts to Twitch chat (custom commands,
 * counters, shoutouts, timers, EventSub messages, etc.) via {@link sayInChannel} in `twitchBot.ts`,
 * so a burst from one feature can't starve or rate-limit another posting to the same channel.
 */
const MIN_SEND_INTERVAL_MS = 1_500;

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
 * closer together than {@link MIN_SEND_INTERVAL_MS}. Queued per channel — a call returns only
 * once it's actually run (send succeeded or threw), and calls for the same channel always run
 * in the order they were enqueued.
 * @param channel - Normalized Twitch channel name the send is targeting.
 * @param send - Performs the actual send. Rejecting doesn't affect the timing of later queued sends.
 */
export async function throttledChannelSend(channel: string, send: () => Promise<void>): Promise<void> {
  await channelQueue.run(channel, async () => {
    const now = Date.now();
    const scheduledAt = Math.max(now, nextAllowedAt.get(channel) ?? 0);
    if (scheduledAt > now) await delay(scheduledAt - now);
    nextAllowedAt.set(channel, scheduledAt + MIN_SEND_INTERVAL_MS);
    await send();
  });
}

/** Test-only: clears all per-channel send-timing state so each test starts from a clean slate. */
export function __resetTwitchSendQueueForTests(): void {
  nextAllowedAt.clear();
}
