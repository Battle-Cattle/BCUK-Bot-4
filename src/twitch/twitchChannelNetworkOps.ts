import type { ChatClient } from '@twurple/chat';
import { createLogger } from '../shared/logger';
import { withTimeout } from './twitchSendQueue';

const log = createLogger('Twitch');

/**
 * Like `client.say()`, Twurple's `ChatClient.join()`/`part()` have no built-in timeout and can
 * hang indefinitely on a stalled socket. Callers serialize these behind their own queue/gate, so
 * an unbounded hang here would wedge every later join/part — across every channel — forever.
 * Bounding it guarantees those always free up, even though the underlying call may still be stuck.
 */
export const JOIN_PART_TIMEOUT_MS = 10_000;

// Twitch rate-limits JOIN to 20 per 10 s (2/s). 600 ms ≈ 1.67/s, ~83% of the ceiling.
const JOIN_THROTTLE_MS = 600;

// A chain of promises gating client.join() calls so they're spaced JOIN_THROTTLE_MS apart
// globally — across both the reconnect-reconciliation path and ad-hoc single joins (e.g. from
// the admin panel) — since those are only serialised per-channel by the caller's own mutation
// queue and could otherwise collectively exceed Twitch's IRC JOIN rate limit.
let joinGate: Promise<void> = Promise.resolve();

/**
 * Calls `client.part(channel)` and wraps it in a promise. Unlike `client.join()`, Twurple's
 * `part()` is synchronous and fire-and-forget (no server ack to wait on) — this wrapper exists
 * only so callers can pass it through the same `withTimeout`/{@link compensateIfStale} plumbing
 * shared with `join()`. In practice it always settles on the same tick, so a stalled `part()` and
 * the "stale part landing late" compensation branch cannot occur — only a synchronous throw
 * (converted here into a rejection) is possible.
 */
export async function partAsync(client: ChatClient, channel: string): Promise<void> {
  client.part(channel);
}

/** Resets the global join throttle gate. */
export function resetJoinGate(): void {
  joinGate = Promise.resolve();
}

/**
 * Dependencies {@link compensateIfStale} needs to reconcile real Twitch-side membership against
 * desired state. Passed explicitly (rather than imported directly) so this module doesn't need
 * to reach back into twitchChannelMembership.ts's private state — the accessor functions still
 * read that state live (not a one-time snapshot), since a late-settling call can be watched for
 * minutes after the caller assembled this bundle.
 */
export interface MembershipDeps {
  /** Returns the current Twurple chat client, or null if not set. */
  getClient: () => ChatClient | null;
  /** Whether the client is currently connected. */
  isConnected: () => boolean;
  /** Whether `channel` is currently joined per the live Twurple client's own channel list. */
  isChannelJoined: (channel: string) => boolean;
  /** Whether `channel` is currently desired to be joined (the source of truth for intent). */
  isDesiredJoined: (channel: string) => boolean;
  /** Runs `op` serialized per-channel, so it can't interleave with a concurrent operation on `channel`. */
  runExclusive: (channel: string, op: () => Promise<unknown>) => Promise<unknown>;
  /**
   * Records that `channel`'s membership actually changed (a `join()`/`part()` call genuinely
   * settled), independent of whether the caller that issued it already gave up via a timeout.
   * Needed because {@link isChannelJoined} is backed by the caller's own bookkeeping rather than
   * a live query — without this, a call that lands late (after its caller's `withTimeout` already
   * moved on without recording the outcome) would leave that bookkeeping never learning the real
   * result.
   */
  markJoined: (channel: string) => void;
  /** See {@link markJoined} — the corresponding part-side update. */
  markParted: (channel: string) => void;
}

/**
 * Watches `call` — a `client.join()`/`client.part()` promise — for a late successful settlement
 * that arrives only after its caller has already stopped waiting on it via
 * {@link JOIN_PART_TIMEOUT_MS}. Detected directly from `call`'s own timing (settling at or past
 * the timeout window means the caller's `withTimeout` race already gave up on it) rather than
 * tracking a separate "newer operation" marker, so this catches a timed-out call landing late
 * even when nothing else has since touched the channel — e.g. the timed-out caller's own rollback
 * of its desired-membership state is itself enough to make a late join stale.
 *
 * A late rejection needs no compensation (the call never took effect). A late *success* did take
 * effect on the real Twitch-side membership, so if it no longer matches what's desired, this
 * reconciles it: reverts a stale late join by parting again, or restores a stale late part by
 * rejoining. Runs detached from the caller's own await, which already observed the timeout race
 * independently. The corrective action itself goes through `deps.runExclusive` so it can't
 * interleave with a concurrent legitimate operation on the same channel.
 * @param deps - Accessors for the caller's live client/membership state — see {@link MembershipDeps}.
 * @param channel - The channel the call was for.
 * @param call - The raw (un-timed-out) `client.join()`/`client.part()` promise to watch.
 * @param kind - Which operation `call` performed.
 * @returns Nothing — returns immediately without waiting on `call`. Reconciliation (if any) runs
 *   asynchronously in the background whenever `call` eventually settles.
 */
export function compensateIfStale(deps: MembershipDeps, channel: string, call: Promise<unknown>, kind: 'join' | 'part'): void {
  const startedAt = Date.now();
  call.then(() => {
    // The call actually succeeded — sync bookkeeping to that real outcome regardless of whether
    // the caller's own withTimeout already gave up on it (see markJoined/markParted's doc).
    if (kind === 'join') deps.markJoined(channel); else deps.markParted(channel);

    // Settled within the normal window — the caller's own withTimeout race never gave up on
    // this call, so there's nothing further to reconcile.
    if (Date.now() - startedAt < JOIN_PART_TIMEOUT_MS) return;
    void deps.runExclusive(channel, async () => {
      const client = deps.getClient();
      if (!client || !deps.isConnected()) return;
      const desiredJoined = deps.isDesiredJoined(channel);
      if (kind === 'join' && !desiredJoined && deps.isChannelJoined(channel)) {
        log.warn(`[Twitch] Stale join for ${channel} landed after it was no longer desired active — reverting`);
        const revertCall = partAsync(client, channel);
        // The revert itself can time out and land late, same as any other part call — watch it
        // too, so a stale revert can't silently undo a join that's since become desired again.
        compensateIfStale(deps, channel, revertCall, 'part');
        await withTimeout(revertCall, JOIN_PART_TIMEOUT_MS, 'Twitch part');
      } else if (kind === 'part' && desiredJoined && !deps.isChannelJoined(channel)) {
        log.warn(`[Twitch] Stale part for ${channel} landed while it was still desired active — rejoining`);
        await throttledJoin(client, channel, (joinCall) => compensateIfStale(deps, channel, joinCall, 'join'));
      }
    }).catch((err) => log.error(`Failed to reconcile stale ${kind} for ${channel}:`, err));
  }, () => {});
}

/**
 * Calls `client.join(channel)`, globally throttled to JOIN_THROTTLE_MS between joins across all
 * channels. Bounded by {@link JOIN_PART_TIMEOUT_MS} so a stalled join can't wedge the throttle
 * gate — and every join queued behind it — forever.
 * @param client - The connected Twurple chat client to join with.
 * @param channel - The already-normalized channel name to join.
 * @param onSettled - Called with the raw (un-timed-out) join promise right after it's issued, so
 *   the caller can watch for a late settlement after giving up on it via the timeout race — see
 *   {@link compensateIfStale}. Issuing the join and calling this are both inside the `try`, so
 *   even a synchronous throw from either still releases the gate via `finally` rather than
 *   wedging every later queued join behind it.
 * @returns Resolves once the join call itself has completed (not once the throttle window has
 *   elapsed — the throttle only delays the *next* queued join). Rejects if the join times out.
 */
export async function throttledJoin(client: ChatClient, channel: string, onSettled: (call: Promise<unknown>) => void): Promise<void> {
  const previousGate = joinGate;
  let releaseGate!: () => void;
  joinGate = new Promise((resolve) => { releaseGate = resolve; });
  await previousGate;
  try {
    const joinCall = client.join(channel);
    onSettled(joinCall);
    await withTimeout(joinCall, JOIN_PART_TIMEOUT_MS, 'Twitch join');
  } finally {
    setTimeout(releaseGate, JOIN_THROTTLE_MS);
  }
}
