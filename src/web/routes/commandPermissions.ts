import type { Request } from 'express';
import { AccessLevel, type DbCustomCommandWithAssignments } from '../../db';

/**
 * Whether the session user can manage the whole custom-command catalog (every command, every
 * channel, Discord/multi-Twitch flags, assignments and server overrides) — Mod or above in the
 * current guild. Everyone else gets streamer self-service, limited to their own channel.
 * Assumes `requireGuildContext` has already refreshed `accessLevel` for the current guild.
 * @param req - Express request; reads `req.session.user.accessLevel`.
 * @returns True when the user is Mod or above.
 */
export function canManageCommandCatalog(req: Request): boolean {
  const accessLevel = req.session.user?.accessLevel;
  return accessLevel !== undefined && accessLevel >= AccessLevel.MOD;
}

/**
 * Whether `discordId` is one of the command's assigned Twitch users.
 * @param command - The command with its assigned users.
 * @param discordId - Discord ID to look for.
 * @returns True when the user is assigned to the command.
 */
export function isCommandAssignedTo(command: DbCustomCommandWithAssignments, discordId: string): boolean {
  return command.assigned_users.some((assigned) => assigned.discord_id === discordId);
}

/**
 * Whether a streamer below Mod may edit or delete `command` themselves: it must be assigned to
 * them alone, and must not reach beyond their own channel — so not Discord-enabled (fires in every
 * server) and not multi-Twitch (fires in every active Twitch channel). Anything else is read-only
 * to them apart from removing it from their own channel.
 * @param command - The command with its assigned users.
 * @param discordId - Discord ID of the streamer.
 * @returns True when the streamer owns the command outright.
 */
export function isCommandSelfManageable(command: DbCustomCommandWithAssignments, discordId: string): boolean {
  return command.assigned_users.length === 1
    && command.assigned_users[0].discord_id === discordId
    && !command.is_discord_enabled
    && !command.is_multi_twitch;
}
