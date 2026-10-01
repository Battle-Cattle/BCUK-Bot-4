import type { Request } from 'express';
import { AccessLevel, isTimerSelfManageableBy, type DbTimerCommandWithAssignments } from '../../db';

/**
 * Whether the session user can manage the whole timer catalog (every timer, every channel, and
 * streamer assignments) — Mod or above in the current guild. Everyone else gets streamer
 * self-service, limited to their own channel.
 * Assumes `requireGuildContext` has already refreshed `accessLevel` for the current guild.
 * @param req - Express request; reads `req.session.user.accessLevel`.
 * @returns True when the user is Mod or above.
 */
export function canManageTimerCatalog(req: Request): boolean {
  const accessLevel = req.session.user?.accessLevel;
  return accessLevel !== undefined && accessLevel >= AccessLevel.MOD;
}

/**
 * Whether `discordId` is one of the timer's assigned Twitch users.
 * @param timer - The timer with its assigned users.
 * @param discordId - Discord ID to look for.
 * @returns True when the user is assigned to the timer.
 */
export function isTimerAssignedTo(timer: DbTimerCommandWithAssignments, discordId: string): boolean {
  return timer.assigned_users.some((assigned) => assigned.discord_id === discordId);
}

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
