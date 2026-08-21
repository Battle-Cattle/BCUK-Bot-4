import { Request, Response } from 'express';
import { createLogger } from '../../shared/logger';
import { findUser, getMemberAccessLevel, AccessLevel } from '../../db';
import { trimField, normalizeDiscordId } from './validation';
import { getSessionUser } from '../session';
import { normalizeTwitchChannelName } from '../../twitch/twitchChannelName';
import { isLockWaitTimeoutDbError } from './adminUserMutations';

const log = createLogger('Web');

/**
 * Resolves the acting user's current guild from the session.
 * Redirects to the guild picker and returns null when no guild is selected.
 *
 * @param req The incoming request (reads `getSessionUser(req).currentGuildId`).
 * @param res The response, used to redirect when no guild is set.
 */
export function resolveGuildId(req: Request, res: Response): string | null {
  const guildId = getSessionUser(req).currentGuildId;
  if (!guildId) {
    res.redirect('/guild/select');
    return null;
  }
  return guildId;
}

/**
 * Trims and validates a submitted `discord_id` field. Returns the normalized ID,
 * or redirects and returns null: to `/admin/users` when the field is absent, or
 * to `?error=invalid_discord_id` when it is malformed.
 *
 * @param res The response, used to redirect on absent/invalid input.
 * @param rawId The raw `discord_id` value from the request body.
 */
export function resolveValidDiscordId(res: Response, rawId: string | undefined): string | null {
  const trimmed = trimField(rawId);
  if (!trimmed) {
    res.redirect('/admin/users');
    return null;
  }
  if (discordIdError(trimmed)) {
    res.redirect('/admin/users?error=invalid_discord_id');
    return null;
  }
  return trimmed;
}

/**
 * Returns `'invalid_discord_id'` when `id` doesn't look like a Discord snowflake, else null.
 * Derives its answer from `normalizeDiscordId` rather than maintaining a second snowflake regex.
 */
export function discordIdError(id: string): string | null {
  return normalizeDiscordId(id) ? null : 'invalid_discord_id';
}

/** Returns `'invalid_access_level'` when `levelStr` isn't a known `AccessLevel` value, else null. */
export function accessLevelError(levelStr: string): string | null {
  if (!/^\d+$/.test(levelStr)) return 'invalid_access_level';
  return (Object.values(AccessLevel) as number[]).includes(Number(levelStr)) ? null : 'invalid_access_level';
}

/** Parses a form checkbox/boolean value (`'true'`/`'1'`/`'false'`/`'0'`) into a boolean, or null if unrecognized. */
export function parseTwitchEnabled(val: string | undefined): boolean | null {
  if (val === 'true' || val === '1') return true;
  if (val === 'false' || val === '0') return false;
  return null;
}

/** Result of validating a submitted Twitch name field. */
export interface ParsedTwitchInput {
  error: string | null;
  normalizedTwitchName: string | null;
  shouldClearTwitchName: boolean;
}

/**
 * Trims and normalizes a submitted Twitch channel name, honoring an explicit "clear" flag.
 *
 * @param twitchName The raw Twitch name field from the request body.
 * @param clearTwitchName Raw `clear_twitch_name` field; `'1'` clears the name regardless of `twitchName`.
 * @returns The parsed result: normalized name, whether to clear it, and an error code when the name is invalid.
 */
export function parseTwitchNameInput(
  twitchName: string | undefined,
  clearTwitchName: string | undefined,
): ParsedTwitchInput {
  const shouldClearTwitchName = clearTwitchName === '1';
  const trimmed = trimField(twitchName);
  const normalizedTwitchName = trimmed ? normalizeTwitchChannelName(trimmed) : null;
  if (!shouldClearTwitchName && trimmed && !normalizedTwitchName) {
    return { error: 'invalid_twitch_name', normalizedTwitchName: null, shouldClearTwitchName };
  }
  return { error: null, normalizedTwitchName, shouldClearTwitchName };
}

/**
 * Authorizes a Manager/Admin editing a user's access level within a guild.
 * Returns an error code string, or null when the edit is permitted.
 *
 * Rules: nobody edits themselves through this form; only an owner may edit an
 * owner; and a non-Admin actor may neither assign a level at or above their own
 * nor modify a target who already sits at or above their own level **in this
 * guild** (the target's level is read from `guild_member`, not the global column).
 *
 * @param sessionUser The acting user (current-guild access level + owner flag).
 * @param targetDiscordId The user being edited.
 * @param targetLevel The access level being assigned.
 * @param guildId The guild the edit applies to.
 */
export async function checkManagerEditAuth(
  sessionUser: { discordId: string; accessLevel: number; isOwner?: boolean },
  targetDiscordId: string,
  targetLevel: number,
  guildId: string,
): Promise<string | null> {
  if (targetDiscordId === sessionUser.discordId) return 'self_edit_forbidden';
  // Bot owners are global super-admins — only another owner may touch them.
  const existingUser = await findUser(targetDiscordId);
  if (existingUser?.is_owner && !sessionUser.isOwner) return 'target_above_level';
  if (sessionUser.accessLevel < AccessLevel.ADMIN) {
    if (targetLevel >= sessionUser.accessLevel) return 'access_level_too_high';
    const targetCurrentLevel = await getMemberAccessLevel(guildId, targetDiscordId);
    if (targetCurrentLevel !== null && targetCurrentLevel >= sessionUser.accessLevel) return 'target_above_level';
  }
  return null;
}

/**
 * Validates and resolves inputs for the toggle-twitch route.
 * Checks the enabled flag is parseable, that the target is a member of the current guild,
 * that only an owner may toggle another owner's Twitch state, and that the acting user
 * outranks the target (mirrors `checkManagerEditAuth`'s rules: a non-Admin actor may not
 * modify a target already at or above their own level).
 * Sends the appropriate error redirect and returns null on failure; returns the parsed boolean on success.
 *
 * @param res The response, used to redirect on error.
 * @param sessionUser The acting user (current-guild access level + owner flag).
 * @param guildId The guild to verify membership in.
 * @param targetDiscordId The user whose Twitch state is being toggled.
 * @param isTwitchBotEnabled The raw form value for the enabled flag.
 */
export async function resolveToggleTwitchInputs(
  res: Response,
  sessionUser: { accessLevel: number; isOwner?: boolean },
  guildId: string,
  targetDiscordId: string,
  isTwitchBotEnabled: string | undefined,
): Promise<boolean | null> {
  const nextEnabled = parseTwitchEnabled(isTwitchBotEnabled);
  if (nextEnabled === null) {
    res.redirect('/admin/users?error=invalid_twitch_state');
    return null;
  }
  const memberLevel = await getMemberAccessLevel(guildId, targetDiscordId);
  if (memberLevel === null) {
    res.redirect('/admin/users?error=target_above_level');
    return null;
  }
  // Bot owners are global super-admins — only another owner may touch them, even an Admin.
  const existingUser = await findUser(targetDiscordId);
  if (existingUser?.is_owner && !sessionUser.isOwner) {
    res.redirect('/admin/users?error=target_above_level');
    return null;
  }
  if (!sessionUser.isOwner && sessionUser.accessLevel < AccessLevel.ADMIN && memberLevel >= sessionUser.accessLevel) {
    res.redirect('/admin/users?error=target_above_level');
    return null;
  }
  return nextEnabled;
}

/**
 * Redirects on a DB error from a mutation route: `?error=db_busy` for lock-wait timeouts
 * (logged at warn), or `?error=${failCode}` for anything else (logged at error).
 *
 * @param err The caught error.
 * @param res The response, used to redirect.
 * @param failCode The error code to use for non-lock-timeout failures.
 * @param context Short label identifying the calling route, used in the log line.
 */
export function handleDbError(err: unknown, res: Response, failCode: string, context: string): void {
  if (isLockWaitTimeoutDbError(err)) {
    log.warn(`${context} DB lock timeout`, err);
    res.redirect('/admin/users?error=db_busy');
  } else {
    log.error(`${context} error:`, err);
    res.redirect(`/admin/users?error=${failCode}`);
  }
}
