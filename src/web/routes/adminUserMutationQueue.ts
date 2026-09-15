import { createMutationQueue } from '../../shared/mutationQueue';
import { withTimeout } from '../../shared/withTimeout';

/**
 * Serializes per-`discord_id` writes across admin mutations (add/edit/remove/toggle) and the
 * Discord-name refresh job, since a user can belong to multiple guilds and those operations can
 * otherwise race on the same user row. Shared by admin.ts and adminRefresh.ts so writes for the
 * same discord_id always serialize against each other, not just against writes from the same file.
 */
export const userMutationQueue = createMutationQueue<string>();

const USER_MUTATION_TIMEOUT_MS = 15_000;

/**
 * Runs `operation` serialized against other user mutations for the same `discordId`. The caller's
 * wait is bounded by {@link USER_MUTATION_TIMEOUT_MS} — a stalled DB call (e.g. a hung connection)
 * rejects the returned promise instead of hanging the caller (an HTTP request, a login) forever.
 *
 * The timeout only bounds what the *caller* observes: it wraps `userMutationQueue.run`'s result
 * rather than `operation` itself, so the queue key for `discordId` is released only once
 * `operation` actually settles, never early at the timeout. A still-running stalled operation
 * therefore can't race a later queued mutation for the same user and overwrite its result — the
 * tradeoff is that a later mutation for the *same* `discordId` still waits for the stalled one to
 * genuinely finish (which the DB pool's keepalive setting makes far less likely to be unbounded).
 * @param discordId - Discord ID whose mutations serialize against each other.
 * @param operation - The async work to run once queued.
 * @returns Resolves or rejects with `operation`'s own result, or rejects with a timeout error if
 *   it doesn't settle within {@link USER_MUTATION_TIMEOUT_MS} (`operation` itself keeps running
 *   and its result is still observed by the queue, just no longer awaited by the caller).
 */
export function runUserMutation<T>(discordId: string, operation: () => Promise<T>): Promise<T> {
  return withTimeout(userMutationQueue.run(discordId, operation), USER_MUTATION_TIMEOUT_MS, 'User mutation');
}

/**
 * Runs `operation` with both `actorId`'s and `targetId`'s {@link userMutationQueue} slots held
 * for its duration — for a guarded admin mutation whose `operation` re-reads the *acting* user's
 * current authorization (not just the target's) before writing, so that read and the write it
 * guards need to be atomic against a concurrent mutation for either id, not just the target's.
 *
 * Without this, `runUserMutation(targetId, operation)` alone still leaves a gap: a concurrent
 * mutation demoting the actor runs under its own `runUserMutation(actorId, ...)` call, which
 * doesn't serialize against the target's queue slot at all, so it can commit between this
 * operation's fresh actor-authorization read and its target write. Holding both slots for the
 * operation's whole duration closes that gap — any mutation for either id now waits behind this
 * one, and this one waits behind any already in flight for either id.
 *
 * Acquires the two ids' queue slots in a fixed (lexicographic, not actor/target) order, so two
 * operations referencing the same two ids in swapped actor/target roles (e.g. A edits B, and
 * concurrently B edits A) always request the slots in the same order and can never deadlock
 * waiting on each other's slot. When `actorId === targetId` (impossible in practice — callers
 * reject self-edits — but handled defensively), a single slot is acquired instead of nesting a
 * key inside itself, which {@link userMutationQueue}'s own `run` forbids.
 *
 * This compounds {@link runUserMutation}'s own documented timeout tradeoff: `firstId`'s slot here
 * is released only once the *nested* `run(secondId, operation)` call itself settles, not at
 * `firstId`'s own turn — so a slow queue for `secondId` (e.g. many other mutations already
 * pending for that id) delays `firstId` for everyone else waiting on it too, for longer than
 * {@link USER_MUTATION_TIMEOUT_MS} bounds for this call's own caller. This is accepted for the
 * same reason `runUserMutation`'s single-key version is: every operation queued here is a couple
 * of bounded DB writes on the same pool (no unbounded external call), so a queue backing up this
 * badly would mean the DB itself is in trouble, not that this locking scheme introduced a new
 * failure mode. A true fix would need a multi-key queue with atomic acquisition and real
 * cancellation, which is a materially different (and riskier) primitive than this file's simple
 * per-key `Promise` chaining — out of scope for the TOCTOU fix this function exists for.
 *
 * @param actorId - The acting user's discordId.
 * @param targetId - The mutation's target discordId.
 * @param operation - The auth-check-then-write to run with both slots held.
 * @returns Resolves or rejects with `operation`'s own result, subject to the same
 *   {@link USER_MUTATION_TIMEOUT_MS} bound as {@link runUserMutation}.
 */
export function runUserMutationForActorAndTarget<T>(
  actorId: string,
  targetId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (actorId === targetId) {
    return withTimeout(userMutationQueue.run(targetId, operation), USER_MUTATION_TIMEOUT_MS, 'User mutation');
  }
  const [firstId, secondId] = actorId < targetId ? [actorId, targetId] : [targetId, actorId];
  return withTimeout(
    userMutationQueue.run(firstId, () => userMutationQueue.run(secondId, operation)),
    USER_MUTATION_TIMEOUT_MS,
    'User mutation',
  );
}
