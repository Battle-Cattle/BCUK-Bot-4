import { createMutationQueue } from '../../shared/mutationQueue';

/**
 * Serializes per-`discord_id` writes across admin mutations (add/edit/remove/toggle) and the
 * Discord-name refresh job, since a user can belong to multiple guilds and those operations can
 * otherwise race on the same user row. Shared by admin.ts and adminRefresh.ts so writes for the
 * same discord_id always serialize against each other, not just against writes from the same file.
 */
export const userMutationQueue = createMutationQueue();
