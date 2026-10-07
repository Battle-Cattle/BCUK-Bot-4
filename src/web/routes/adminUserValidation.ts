// Input parsing and validation for the admin user-management routes. Authorization checks live in
// `adminUserAuth.ts`; mapping DB errors to redirects lives in `adminUserErrors.ts`.
import { Request, Response } from 'express';
import { AccessLevel } from '../../db';
import { trimField, normalizeDiscordId } from './validation';
import { getSessionUser } from '../session';
import { normalizeTwitchChannelName } from '../../twitch/twitchChannelName';

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
