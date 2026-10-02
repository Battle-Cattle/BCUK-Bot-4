import type { Request } from 'express';
import {
  discardOwnNewTimerCommand,
  findUser,
  getMemberAccessLevel,
  removeOwnTimerCommand,
  removeTimerCommand,
  setOwnTimerCommandEnabled,
  setTimerCommandEnabled,
  TimerCommandNotFoundError,
  TimerSelfServiceDeniedError,
  updateOwnTimerCommand,
  updateTimerCommand,
  type TimerCommandInput,
} from '../../db';
import { parseDiscordIdList } from './validation';
import { canManageTimerCatalog } from './timerPermissions';
import { getCurrentGuildId } from '../session';

// Which timer write the session user gets: Mod+ use the unrestricted catalog writes; a streamer
// below Mod gets timers on their own channel only, and their updates/toggles/deletes go through the
// *Own* DB writes, which re-check ownership inside the write's own transaction. Kept apart from
// timersMutations.ts so the routes only handle HTTP.

/**
 * Maps the not-found/not-yours errors a timer write can throw to their redirect codes.
 * @param err - The error thrown by the write.
 * @returns `timer_not_found`, `forbidden`, or null for any other error.
 */
export function timerAccessErrorCode(err: unknown): string | null {
  if (err instanceof TimerCommandNotFoundError) return 'timer_not_found';
  if (err instanceof TimerSelfServiceDeniedError) return 'forbidden';
  return null;
}

/**
 * Works out who a new timer is assigned to. Mod+ pick users via `discord_ids`, all of whom must be
 * members of the session's current guild; a streamer below Mod always gets the timer on their own
 * channel only (they're a member by `requireGuildContext`), which needs a linked Twitch account.
 * @param req - Express request; reads `discord_ids`, the session user and its current guild.
 * @returns The Discord IDs to assign, or an `error` code (`assignee_not_in_guild`,
 *   `twitch_not_linked`) to redirect with.
 */
export async function resolveNewTimerAssignees(req: Request): Promise<{ discordIds: string[] } | { error: string }> {
  if (canManageTimerCatalog(req)) {
    const discordIds = parseDiscordIdList(req.body.discord_ids);
    if (discordIds.length === 0) return { discordIds };
    const guildId = getCurrentGuildId(req);
    const levels = await Promise.all(discordIds.map((id) => getMemberAccessLevel(guildId, id)));
    if (levels.some((level) => level === null)) return { error: 'assignee_not_in_guild' };
    return { discordIds };
  }
  const selfId = req.session.user!.discordId;
  const self = await findUser(selfId);
  if (!self?.twitch_name) return { error: 'twitch_not_linked' };
  return { discordIds: [selfId] };
}

/**
 * Updates a timer as the session user: the unrestricted `updateTimerCommand` for Mod+, or the
 * owner-checked `updateOwnTimerCommand` for a streamer below Mod.
 * @param req - Express request; reads the session user.
 * @param timerId - ID of the timer to update.
 * @param input - The timer's new fields.
 * @returns Resolves once the update completes; rejects with the DB write's error (see
 *   {@link timerAccessErrorCode}).
 */
export async function updateTimerAsSessionUser(req: Request, timerId: number, input: TimerCommandInput): Promise<void> {
  if (canManageTimerCatalog(req)) return updateTimerCommand(timerId, input);
  return updateOwnTimerCommand(timerId, input, req.session.user!.discordId);
}

/**
 * Enables/disables a timer as the session user: the unrestricted `setTimerCommandEnabled` for
 * Mod+, or the owner-checked `setOwnTimerCommandEnabled` for a streamer below Mod.
 * @param req - Express request; reads the session user.
 * @param timerId - ID of the timer to toggle.
 * @param enabled - The new enabled state.
 * @returns Resolves once the update completes; rejects with the DB write's error (see
 *   {@link timerAccessErrorCode}).
 */
export async function setTimerEnabledAsSessionUser(req: Request, timerId: number, enabled: boolean): Promise<void> {
  if (canManageTimerCatalog(req)) return setTimerCommandEnabled(timerId, enabled);
  return setOwnTimerCommandEnabled(timerId, enabled, req.session.user!.discordId);
}

/**
 * Deletes a timer as the session user: the unrestricted `removeTimerCommand` for Mod+, or the
 * owner-checked `removeOwnTimerCommand` for a streamer below Mod.
 * @param req - Express request; reads the session user.
 * @param timerId - ID of the timer to delete.
 * @returns Resolves once the delete completes; rejects with the DB write's error (see
 *   {@link timerAccessErrorCode}).
 */
export async function removeTimerAsSessionUser(req: Request, timerId: number): Promise<void> {
  if (canManageTimerCatalog(req)) return removeTimerCommand(timerId);
  return removeOwnTimerCommand(timerId, req.session.user!.discordId);
}

/**
 * Cleans up a just-created timer whose assignment failed, as the session user: the unrestricted
 * `removeTimerCommand` for Mod+, or `discardOwnNewTimerCommand` for a streamer below Mod, which
 * leaves the timer alone if a Mod adopted it in the meantime.
 * @param req - Express request; reads the session user.
 * @param timerId - ID of the timer to discard.
 * @returns Resolves once the cleanup completes; rejects if it fails or is denied.
 */
export async function discardNewTimerAsSessionUser(req: Request, timerId: number): Promise<void> {
  if (canManageTimerCatalog(req)) return removeTimerCommand(timerId);
  return discardOwnNewTimerCommand(timerId, req.session.user!.discordId);
}
