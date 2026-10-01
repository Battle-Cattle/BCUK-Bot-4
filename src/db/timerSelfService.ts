/**
 * Whether a streamer below Mod may edit, toggle or delete a timer themselves: it must be assigned
 * to them alone, so a change can't reach another streamer's channel. The single definition of the
 * rule, shared by the timers page and the locked write paths in `timerCommands.ts`. Kept in its
 * own dependency-free module so it can be used (and tested) without the DB pool.
 * @param assignedDiscordIds - Discord IDs of every user assigned to the timer.
 * @param discordId - Discord ID of the streamer.
 * @returns True when the streamer owns the timer outright.
 */
export function isTimerSelfManageableBy(assignedDiscordIds: string[], discordId: string): boolean {
  return assignedDiscordIds.length === 1 && assignedDiscordIds[0] === discordId;
}

/**
 * Whether a streamer's own just-created timer is still unclaimed, so a failed self-assignment may
 * clean it up: no assignee other than the streamer (a failed assignment may have left none). If a
 * Mod adopted the new timer in the meantime by assigning someone else, the cleanup must leave it
 * alone.
 * @param assignedDiscordIds - Discord IDs of every user assigned to the timer.
 * @param discordId - Discord ID of the streamer who created it.
 * @returns True when the timer is still the streamer's, unadopted.
 */
export function isTimerUnclaimedBy(assignedDiscordIds: string[], discordId: string): boolean {
  return assignedDiscordIds.every((assigned) => assigned === discordId);
}
