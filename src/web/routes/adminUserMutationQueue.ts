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
 * Runs `operation` serialized against other user mutations for the same `discordId`, bounded by
 * {@link USER_MUTATION_TIMEOUT_MS} so a stalled DB call (e.g. a hung connection) can't wedge this
 * discord_id's queue forever — see the hazard documented on `createMutationQueue`'s `run`.
 * @param discordId - Discord ID whose mutations serialize against each other.
 * @param operation - The async work to run once queued.
 * @returns Resolves or rejects with `operation`'s own result, or rejects with a timeout error if
 *   it doesn't settle within {@link USER_MUTATION_TIMEOUT_MS}.
 */
export function runUserMutation<T>(discordId: string, operation: () => Promise<T>): Promise<T> {
  return userMutationQueue.run(discordId, () => withTimeout(operation(), USER_MUTATION_TIMEOUT_MS, 'User mutation'));
}
