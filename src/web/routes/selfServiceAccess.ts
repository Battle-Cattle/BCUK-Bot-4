import type { Request } from 'express';
import { AccessLevel, findUser, getMemberAccessLevel } from '../../db';
import { parseDiscordIdList } from './validation';
import { getCurrentGuildId } from '../session';

// Streamer self-service rules shared by the Custom Commands and Timers pages (see "Access Levels"
// in CLAUDE.md): Mod+ manage the whole catalog; anyone else with a linked Twitch account manages
// only what is on their own channel. The per-entity "may this streamer edit it alone" rules stay
// in commandPermissions.ts / timerPermissions.ts, because they differ.

/**
 * Whether the session user can manage the whole catalog (every entry, every channel, and
 * assignments) — Mod or above in the current guild. Everyone else gets streamer self-service,
 * limited to their own channel. Assumes `requireGuildContext` has already refreshed `accessLevel`
 * for the current guild.
 * @param req - Express request; reads `req.session.user.accessLevel`.
 * @returns True when the user is Mod or above.
 */
export function canManageCatalog(req: Request): boolean {
  const accessLevel = req.session.user?.accessLevel;
  return accessLevel !== undefined && accessLevel >= AccessLevel.MOD;
}

/**
 * Runs a write as the session user: `catalogWrite` (the unrestricted catalog write) for Mod+,
 * otherwise `ownWrite` (the owner-checked `*Own*` write) with the user's Discord ID, which
 * re-checks ownership inside the write's own transaction.
 * @param req - Express request; reads the session user, which `requireAuth` guarantees on every
 *   route that calls this.
 * @param catalogWrite - The unrestricted write, for a catalog manager.
 * @param ownWrite - The owner-checked write, given the session user's Discord snowflake.
 * @returns Resolves with the write's result; rejects with its error, or if there is no session user.
 */
export async function dispatchByAccess<T>(
  req: Request,
  catalogWrite: () => Promise<T>,
  ownWrite: (discordId: string) => Promise<T>,
): Promise<T> {
  if (canManageCatalog(req)) return catalogWrite();
  const user = req.session.user;
  if (!user) throw new Error('dispatchByAccess: no session user (requireAuth must run first)');
  return ownWrite(user.discordId);
}

/** An error class a self-service write can throw, matched with `instanceof`. */
type ErrorClass = abstract new (...args: never[]) => Error;

/**
 * Maps the not-found/not-yours errors a self-service write can throw to their redirect codes.
 * @param err - The error thrown by the write.
 * @param notFoundError - The write's "no such entry" error class.
 * @param notFoundCode - Redirect code for `notFoundError`, e.g. `command_not_found`.
 * @param deniedError - The write's "not yours to change" error class, mapped to `forbidden`.
 * @returns `notFoundCode`, `forbidden`, or null for any other error.
 */
export function accessErrorCode(
  err: unknown,
  notFoundError: ErrorClass,
  notFoundCode: string,
  deniedError: ErrorClass,
): string | null {
  if (err instanceof notFoundError) return notFoundCode;
  if (err instanceof deniedError) return 'forbidden';
  return null;
}

/**
 * Whether `discordId` is one of an entry's assigned Twitch users.
 * @param entry - A command or timer with its assigned users.
 * @param discordId - Discord ID to look for.
 * @returns True when the user is assigned to the entry.
 */
export function isAssignedTo(entry: { assigned_users: Array<{ discord_id: string }> }, discordId: string): boolean {
  return entry.assigned_users.some((assigned) => assigned.discord_id === discordId);
}

/**
 * Works out who a new command or timer is assigned to. Mod+ pick users via `discord_ids`, all of
 * whom must be members of the session's current guild; a streamer below Mod always gets the entry
 * on their own channel only (they're a member by `requireGuildContext`), which needs a linked
 * Twitch account.
 * @param req - Express request; reads `discord_ids`, the session user and its current guild.
 * @returns The Discord IDs to assign, or an `error` code (`assignee_not_in_guild`,
 *   `twitch_not_linked`) to redirect with.
 */
export async function resolveNewAssignees(req: Request): Promise<{ discordIds: string[] } | { error: string }> {
  if (canManageCatalog(req)) {
    const discordIds = parseDiscordIdList(req.body.discord_ids);
    if (discordIds.length === 0) return { discordIds };
    const guildId = getCurrentGuildId(req);
    const levels = await Promise.all(discordIds.map((id) => getMemberAccessLevel(guildId, id)));
    if (levels.some((level) => level === null)) return { error: 'assignee_not_in_guild' };
    return { discordIds };
  }
  const selfId = req.session.user!.discordId; // requireAuth guarantees a session user
  const self = await findUser(selfId);
  if (!self?.twitch_name) return { error: 'twitch_not_linked' };
  return { discordIds: [selfId] };
}
