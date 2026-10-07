import { isTimerSelfManageableBy, type DbTimerCommandWithAssignments } from '../../db';

/**
 * Whether a streamer below Mod may edit, toggle or delete `timer` themselves — the page-side view
 * of `isTimerSelfManageableBy` (assigned to them alone). Only decides what the page offers; the
 * write itself re-checks the same rule under a lock.
 * @param timer - The timer with its assigned users.
 * @param discordId - Discord ID of the streamer.
 * @returns True when the streamer owns the timer outright.
 */
export function isTimerSelfManageable(timer: DbTimerCommandWithAssignments, discordId: string): boolean {
  return isTimerSelfManageableBy(timer.assigned_users.map((assigned) => assigned.discord_id), discordId);
}
