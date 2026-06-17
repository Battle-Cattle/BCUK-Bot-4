import { createMutationQueue } from '../../shared/mutationQueue';

// A user can belong to multiple guilds, so admin mutations (add/edit/remove/toggle)
// and the Discord-name refresh job can run concurrently and race on the same user
// row. Shared by admin.ts and adminRefresh.ts so writes for the same discord_id
// always serialize against each other, not just against writes from the same file.
export const userMutationQueue = createMutationQueue();
