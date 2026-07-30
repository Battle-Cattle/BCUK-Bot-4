import { createMutationQueue } from '../shared/mutationQueue';

/**
 * Twitch enforces its chat message rate limits as two token buckets *per bot account*, shared
 * across every channel the bot posts to — not one bucket per channel. Every outgoing message
 * draws from the moderator bucket, whether or not the bot is privileged (moderator/VIP/
 * broadcaster) in the target channel. A message to a channel where the bot is *not* privileged
 * also draws from the smaller user bucket. That means a burst of privileged sends can leave too
 * few moderator-bucket tokens for a following non-privileged send, even though the user bucket
 * itself still has room — a per-channel spacing limiter can't express that shared contention,
 * so this models both buckets as rolling 30s windows shared globally instead.
 */
const BUCKET_WINDOW_MS = 30_000;

/** Consumed by every send, privileged or not — Twitch's 100-messages-per-30s moderator/VIP/broadcaster limit. */
const MODERATOR_BUCKET_CAPACITY = 100;

/** Consumed only by sends to a channel where the bot isn't privileged there — Twitch's 20-messages-per-30s limit. */
const USER_BUCKET_CAPACITY = 20;

/** Timestamps (epoch ms) of sends counted in the moderator bucket's current rolling window. */
let moderatorBucketTimestamps: number[] = [];
/** Timestamps (epoch ms) of sends counted in the user bucket's current rolling window. */
let userBucketTimestamps: number[] = [];

// Twitch's buckets are per-account, not per-channel, so every send — regardless of target
// channel — contends for the same tokens. A single global queue serializes them; this also
// guarantees sends are never reordered relative to each other, including across channels.
const globalQueue = createMutationQueue<'global'>();

/** Resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Drops entries older than the rolling window from `timestamps` (mutated in place). */
function pruneExpired(timestamps: number[], now: number): void {
  while (timestamps.length > 0 && now - timestamps[0] >= BUCKET_WINDOW_MS) {
    timestamps.shift();
  }
}

/**
 * Waits until `timestamps` has room for one more entry under `capacity`, pruning expired
 * entries first and re-checking after however long the oldest remaining entry takes to age out
 * of the rolling window.
 */
async function waitForBucketRoom(timestamps: number[], capacity: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    pruneExpired(timestamps, now);
    if (timestamps.length < capacity) return;
    await delay(BUCKET_WINDOW_MS - (now - timestamps[0]));
  }
}

/**
 * Runs `send`, waiting as needed for Twitch's global per-account rate-limit buckets to have
 * room first (see the module doc for how the two buckets interact). Every call draws from the
 * moderator bucket; a call for a channel where the bot isn't privileged there also draws from
 * the user bucket. Calls are serialized on a single global queue, so they always run in the
 * order they were enqueued, regardless of which channel each one targets.
 * @param isPrivileged - Whether the bot currently has moderator/VIP/broadcaster status in the channel being sent to.
 * @param send - Performs the actual send. Rejecting doesn't affect the timing of later queued sends.
 */
export async function throttledTwitchSend(isPrivileged: boolean, send: () => Promise<void>): Promise<void> {
  await globalQueue.run('global', async () => {
    await waitForBucketRoom(moderatorBucketTimestamps, MODERATOR_BUCKET_CAPACITY);
    if (!isPrivileged) await waitForBucketRoom(userBucketTimestamps, USER_BUCKET_CAPACITY);

    const sentAt = Date.now();
    moderatorBucketTimestamps.push(sentAt);
    if (!isPrivileged) userBucketTimestamps.push(sentAt);

    await send();
  });
}

/** Test-only: clears both rate-limit buckets so each test starts from a clean slate. */
export function __resetTwitchSendQueueForTests(): void {
  moderatorBucketTimestamps = [];
  userBucketTimestamps = [];
}
