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
