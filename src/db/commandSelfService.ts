/**
 * Whether a streamer below Mod may edit or delete a command themselves: it must be assigned to
 * them alone, and must not reach beyond their own channel — so not Discord-enabled (fires in every
 * server) and not multi-Twitch (fires in every active Twitch channel). The single definition of
 * the rule, shared by the commands page and the locked write paths in `customCommands.ts`. Kept in
 * its own dependency-free module so it can be used (and tested) without the DB pool.
 * @param command - The command's Discord/multi-Twitch flags.
 * @param assignedDiscordIds - Discord IDs of every user assigned to the command.
 * @param discordId - Discord ID of the streamer.
 * @returns True when the streamer owns the command outright.
 */
export function isCommandSelfManageableBy(
  command: { is_discord_enabled: boolean; is_multi_twitch: boolean },
  assignedDiscordIds: string[],
  discordId: string,
): boolean {
  return assignedDiscordIds.length === 1
    && assignedDiscordIds[0] === discordId
    && !command.is_discord_enabled
    && !command.is_multi_twitch;
}

/**
 * Whether a streamer's own just-created command is still unclaimed, so a failed self-assignment
 * may clean it up: no Discord or multi-Twitch flag, and no assignee other than the streamer (a
 * failed assignment may have left none). If a Mod adopted the new command in the meantime, by
 * assigning someone else or turning on a cross-channel flag, the cleanup must leave it alone.
 * @param command - The command's Discord/multi-Twitch flags.
 * @param assignedDiscordIds - Discord IDs of every user assigned to the command.
 * @param discordId - Discord ID of the streamer who created it.
 * @returns True when the command is still the streamer's, unadopted.
 */
export function isCommandUnclaimedBy(
  command: { is_discord_enabled: boolean; is_multi_twitch: boolean },
  assignedDiscordIds: string[],
  discordId: string,
): boolean {
  return assignedDiscordIds.every((assigned) => assigned === discordId)
    && !command.is_discord_enabled
    && !command.is_multi_twitch;
}
