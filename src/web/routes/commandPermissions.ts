import { isCommandSelfManageableBy, type DbCustomCommandWithAssignments } from '../../db';

/**
 * Whether a streamer below Mod may edit or delete `command` themselves — the page-side view of
 * `isCommandSelfManageableBy` (assigned to them alone, not Discord-enabled, not multi-Twitch).
 * Only decides what the page offers; the write itself re-checks the same rule under a lock.
 * @param command - The command with its assigned users.
 * @param discordId - Discord ID of the streamer.
 * @returns True when the streamer owns the command outright.
 */
export function isCommandSelfManageable(command: DbCustomCommandWithAssignments, discordId: string): boolean {
  return isCommandSelfManageableBy(command, command.assigned_users.map((assigned) => assigned.discord_id), discordId);
}
