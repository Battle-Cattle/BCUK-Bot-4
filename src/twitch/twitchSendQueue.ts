import { createMutationQueue } from '../shared/mutationQueue';

/**
 * Twitch's chat message rate limits (dev.twitch.tv/docs/irc/#rate-limits), per bot account,
 * shared across every channel the bot posts to — not one allowance per channel:
 *
 * - A single rolling 30s window counts every outgoing message, whether the bot is privileged
 *   (moderator/VIP/broadcaster) in the target channel or not — privileged sends still add to
 *   the same count non-privileged sends do.
 * - A non-privileged send is blocked once that count reaches 20 in the window.
 * - A privileged send is *not* blocked by that 20 threshold — it still adds to the same count,
 *   but keeps being allowed until the count reaches the higher ceiling of 100.
 * - Separately, a non-privileged send is capped at 1 message per second *per channel*
 *   (privileged sends are exempt), regardless of how much room the 30s window has left.
 *
 * One consequence: a burst of privileged sends can push the shared 30s count past 20, which
 * then blocks a *non*-privileged send to a completely different channel even though that
 * channel's own per-second floor is untouched — the count is shared account-wide, not scoped
 * to either channel.
 */
const WINDOW_MS = 30_000;

/** Blocks a non-privileged send once the shared 30s count reaches this. */
const NON_PRIVILEGED_LIMIT = 20;

/** Blocks a privileged send once the shared 30s count reaches this — privileged sends aren't blocked by {@link NON_PRIVILEGED_LIMIT}. */
const PRIVILEGED_LIMIT = 100;

/** Minimum spacing between two non-privileged sends to the same channel, independent of the shared 30s count. */
const NON_PRIVILEGED_CHANNEL_FLOOR_MS = 1_000;

/**
 * Caps how many times {@link throttledTwitchSend} re-checks `isPrivileged` before giving up and
 * proceeding with whichever status it last observed. Without this bound, a status that keeps
 * flipping between every check (e.g. tmi.js's per-channel userstate churning during a busy
 * Shared Chat session) would spin the recheck loop forever — since that loop runs *before*
 * {@link SEND_TIMEOUT_MS} ever applies (that only bounds the final `send()` call), an unbounded
 * loop would never call `send()` at all, and would wedge {@link globalQueue}'s single `'global'`
 * lane for every later send, across every channel and feature, with no error and nothing to log.
 */
const MAX_PRIVILEGE_RECHECKS = 5;

/**
 * Every send in this module runs behind a single global queue, so one stalled `send()` (tmi.js's
 * `client.say()` has no built-in timeout and can hang indefinitely on a stalled socket) would
 * otherwise wedge every later send, across every channel and feature, forever. Bounding it here
 * guarantees the queue always frees up, even though the underlying send may still be stuck.
 */
const SEND_TIMEOUT_MS = 10_000;

/** Timestamps (epoch ms) of every send — privileged or not — counted in the current rolling window. */
let sentTimestamps: number[] = [];

/** Per-channel timestamp of the most recent non-privileged send, for {@link NON_PRIVILEGED_CHANNEL_FLOOR_MS}. */
const lastNonPrivilegedSendAtByChannel = new Map<string, number>();

// Twitch's rate limit is per-account, not per-channel, so every send — regardless of target
// channel — contends for the same shared count. A single global queue serializes them; this
// also guarantees sends are never reordered relative to each other, including across channels.
const globalQueue = createMutationQueue<'global'>();

/** Resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Drops entries older than the rolling window from {@link sentTimestamps} (mutated in place). */
function pruneExpired(now: number): void {
  while (sentTimestamps.length > 0 && now - sentTimestamps[0] >= WINDOW_MS) {
    sentTimestamps.shift();
  }
}

/**
 * Waits until the shared 30s window has room for one more send under `limit`, pruning expired
 * entries first and re-checking after however long the oldest remaining entry takes to age out.
 */
async function waitForWindowRoom(limit: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    pruneExpired(now);
    if (sentTimestamps.length < limit) return;
    await delay(WINDOW_MS - (now - sentTimestamps[0]));
  }
}

/** Waits, if needed, so a non-privileged send to `channel` respects {@link NON_PRIVILEGED_CHANNEL_FLOOR_MS}. */
async function waitForChannelFloor(channel: string): Promise<void> {
  const last = lastNonPrivilegedSendAtByChannel.get(channel);
  if (last === undefined) return;
  const elapsed = Date.now() - last;
  if (elapsed < NON_PRIVILEGED_CHANNEL_FLOOR_MS) await delay(NON_PRIVILEGED_CHANNEL_FLOOR_MS - elapsed);
}

/**
 * Races `promise` against a `ms`-millisecond timeout, rejecting with a timeout error if it
 * doesn't settle in time. `promise` itself is left running — its eventual settlement is still
 * observed (and silently ignored) so it can never surface as an unhandled rejection later.
 * @param promise - The promise to bound.
 * @param ms - Milliseconds to wait before rejecting with a timeout error.
 * @param label - Describes what timed out, used in the rejection message (e.g. `'Twitch send'`).
 * @returns `promise`'s resolved value if it settles first; otherwise rejects with `promise`'s
 *   own rejection reason, or a timeout error if neither happens within `ms`.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Runs `send` for `channel`, waiting as needed for Twitch's global per-account rate limit to
 * have room first (see the module doc for exactly how the shared window and per-channel floor
 * interact). Calls are serialized on a single global queue, so they always run in the order
 * they were enqueued, regardless of which channel each one targets.
 * @param channel - Normalized Twitch channel name the send is targeting.
 * @param isPrivileged - Resolves whether the bot currently has moderator/VIP/broadcaster status
 *   in `channel`. Called right before the window/floor checks (not at enqueue time), since this
 *   call may have been waiting behind others — the same reason `send` rechecks the connection
 *   itself rather than trusting a snapshot taken before it was queued. Re-checked again after
 *   each wait and the checks re-run under the refreshed status if it changed, since the wait
 *   itself (up to the full 30s window) is another window for status to change again — bounded by
 *   {@link MAX_PRIVILEGE_RECHECKS} so a status that never stops changing can't spin this forever.
 * @param send - Performs the actual send, bounded by {@link SEND_TIMEOUT_MS} so a stalled send
 *   can't wedge the queue forever. Rejecting (including via that timeout) doesn't affect the
 *   timing of later queued sends.
 * @returns Resolves once `send` has actually run and settled (successfully or not); rejects with
 *   whatever `send` rejected with, including a timeout error if it didn't settle in time.
 */
export async function throttledTwitchSend(channel: string, isPrivileged: () => boolean, send: () => Promise<void>): Promise<void> {
  await globalQueue.run('global', async () => {
    let privileged = isPrivileged();
    for (let attempt = 0; attempt < MAX_PRIVILEGE_RECHECKS; attempt++) {
      await waitForWindowRoom(privileged ? PRIVILEGED_LIMIT : NON_PRIVILEGED_LIMIT);
      if (!privileged) await waitForChannelFloor(channel);

      // The wait above can itself take a while (up to the full 30s window), so status may have
      // changed again while waiting. Loop under the refreshed status until a pass finds it
      // unchanged from what it started with — i.e. nothing to re-wait for. Gives up after
      // MAX_PRIVILEGE_RECHECKS and proceeds with the last-observed status rather than waiting
      // forever — see the constant's doc for why an unbounded loop here is unsafe.
      const recheck = isPrivileged();
      if (recheck === privileged) break;
      privileged = recheck;

      // A change caught on the very last allowed attempt would otherwise fall out of the loop
      // without ever waiting under this newest status's own limit/floor — apply it once here so
      // giving up on rechecking can't also skip the rate limit for whichever status we settle on.
      if (attempt === MAX_PRIVILEGE_RECHECKS - 1) {
        await waitForWindowRoom(privileged ? PRIVILEGED_LIMIT : NON_PRIVILEGED_LIMIT);
        if (!privileged) await waitForChannelFloor(channel);
      }
    }

    const sentAt = Date.now();
    sentTimestamps.push(sentAt);
    if (!privileged) lastNonPrivilegedSendAtByChannel.set(channel, sentAt);

    await withTimeout(send(), SEND_TIMEOUT_MS, 'Twitch send');
  });
}

/** Test-only: clears all rate-limit state so each test starts from a clean slate. */
export function __resetTwitchSendQueueForTests(): void {
  sentTimestamps = [];
  lastNonPrivilegedSendAtByChannel.clear();
}
