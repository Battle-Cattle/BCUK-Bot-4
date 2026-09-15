import { Request, Response } from 'express';
import { createLogger } from '../../shared/logger';
import { findUser, getMemberAccessLevel, getEffectiveAccessLevelForUser, AccessLevel } from '../../db';
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
 * Thrown by an authorization check run inside a `runUserMutation` callback (see
 * `adminUserMutationQueue.ts`) so the check is evaluated atomically with the write it guards,
 * rather than before the write is even enqueued — see `checkManagerEditAuth`'s and
 * `checkToggleTwitchAuth`'s own doc comments for why that ordering matters. Callers catch this
 * specifically to redirect with `code` instead of falling through to a generic DB-failure redirect.
 */
export class ManagerEditAuthError extends Error {
  constructor(public readonly code: string) {
    super(`Manager edit auth check failed: ${code}`);
    this.name = 'ManagerEditAuthError';
  }
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
 * Callers must run this *inside* the `runUserMutation` callback for `targetDiscordId` (throwing
 * a {@link ManagerEditAuthError} on a non-null result), not before enqueueing it — evaluating it
 * beforehand would read the target's level, then let an unrelated concurrent write for the same
 * user land in between the check and this call's own write, so the decision here could be stale
 * by the time it takes effect. Running it as the first thing inside the queued callback means it
 * always sees the latest committed state, since `runUserMutation` strictly serializes writes per
 * `discordId` and never releases a user's queue slot before its operation actually settles.
 *
 * The actor's own access level and owner flag are likewise re-read from the DB here rather than
 * trusted from `sessionUser`/the session cache: the session value was current when the request
 * came in, but by the time this runs the actor's own queue slot may have already processed an
 * unrelated demotion of them — re-reading closes that gap the same way the target's level is
 * re-read fresh above, instead of authorizing against a possibly-stale snapshot.
 *
 * @param sessionUser The acting user's identity (only `discordId` is used — their access level
 *   and owner flag are re-resolved from the DB, not read off this object).
 * @param targetDiscordId The user being edited.
 * @param targetLevel The access level being assigned.
 * @param guildId The guild the edit applies to.
 */
export async function checkManagerEditAuth(
  sessionUser: { discordId: string },
  targetDiscordId: string,
  targetLevel: number,
  guildId: string,
): Promise<string | null> {
  if (targetDiscordId === sessionUser.discordId) return 'self_edit_forbidden';
  const actingUser = await findUser(sessionUser.discordId);
  const actingIsOwner = actingUser?.is_owner ?? false;
  const actingAccessLevel = actingUser ? await getEffectiveAccessLevelForUser(guildId, actingUser) : AccessLevel.USER;
  // Bot owners are global super-admins — only another owner may touch them.
  const existingUser = await findUser(targetDiscordId);
  if (existingUser?.is_owner && !actingIsOwner) return 'target_above_level';
  if (actingAccessLevel < AccessLevel.ADMIN) {
    if (targetLevel >= actingAccessLevel) return 'access_level_too_high';
    const targetCurrentLevel = await getMemberAccessLevel(guildId, targetDiscordId);
    if (targetCurrentLevel !== null && targetCurrentLevel >= actingAccessLevel) return 'target_above_level';
  }
  return null;
}

/**
 * Authorizes an Admin removing a member from the current guild. Returns an error code string,
 * or null when the removal is permitted.
 *
 * `/users/remove` is already gated `requireAdmin` at the route level, but that check runs against
 * the session's access level at request time, before the operation waits on the target's mutation
 * queue slot — the same staleness `checkManagerEditAuth`'s doc comment describes. An actor whose
 * own Admin access was revoked between the request landing and this operation actually running
 * could otherwise still have their now-unauthorized removal go through.
 *
 * Callers must run this *inside* the `runUserMutation`/`runUserMutationForActorAndTarget` callback
 * for `targetDiscordId` (throwing a {@link ManagerEditAuthError} on a non-null result) — see
 * `checkManagerEditAuth`'s doc comment for why evaluating it before the write is enqueued would
 * let it go stale, including why the actor's own access level is re-read from the DB here rather
 * than trusted from `sessionUser`/the `requireAdmin` middleware's session check.
 *
 * @param sessionUser The acting user's identity (only `discordId` is used — their access level is
 *   re-resolved from the DB, not read off this object or the session).
 * @param guildId The guild to check the actor's current access level in.
 */
export async function checkRemoveAuth(
  sessionUser: { discordId: string },
  guildId: string,
): Promise<string | null> {
  const actingUser = await findUser(sessionUser.discordId);
  const actingAccessLevel = actingUser ? await getEffectiveAccessLevelForUser(guildId, actingUser) : AccessLevel.USER;
  if (actingAccessLevel < AccessLevel.ADMIN) return 'target_above_level';
  return null;
}

/**
 * Authorizes a Manager/Admin toggling a user's Twitch-bot participation within a guild.
 * Returns an error code string, or null when the toggle is permitted.
 *
 * Checks that the target is a member of the current guild, that only an owner may toggle
 * another owner's Twitch state, and that the acting user outranks the target (mirrors
 * `checkManagerEditAuth`'s rules: a non-Admin actor may not modify a target already at or
 * above their own level).
 *
 * Callers must run this *inside* the `runUserMutation` callback for `targetDiscordId` (throwing
 * a {@link ManagerEditAuthError} on a non-null result) — see `checkManagerEditAuth`'s doc comment
 * for why evaluating it before the write is enqueued would let it go stale, including why the
 * actor's own access level and owner flag are re-read from the DB here rather than trusted from
 * `sessionUser`.
 *
 * @param sessionUser The acting user's identity (only `discordId` is used — their access level
 *   and owner flag are re-resolved from the DB, not read off this object).
 * @param guildId The guild to verify membership in.
 * @param targetDiscordId The user whose Twitch state is being toggled.
 */
export async function checkToggleTwitchAuth(
  sessionUser: { discordId: string },
  guildId: string,
  targetDiscordId: string,
): Promise<string | null> {
  const memberLevel = await getMemberAccessLevel(guildId, targetDiscordId);
  if (memberLevel === null) return 'target_above_level';
  const actingUser = await findUser(sessionUser.discordId);
  const actingIsOwner = actingUser?.is_owner ?? false;
  const actingAccessLevel = actingUser ? await getEffectiveAccessLevelForUser(guildId, actingUser) : AccessLevel.USER;
  // Bot owners are global super-admins — only another owner may touch them, even an Admin.
  const existingUser = await findUser(targetDiscordId);
  if (existingUser?.is_owner && !actingIsOwner) return 'target_above_level';
  if (!actingIsOwner && actingAccessLevel < AccessLevel.ADMIN && memberLevel >= actingAccessLevel) {
    return 'target_above_level';
  }
  return null;
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
