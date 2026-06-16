import { Response } from 'express';
import { createLogger } from '../../shared/logger';
import { findUser, getMemberAccessLevel, AccessLevel } from '../../db';
import { trimField } from './shared';
import { normalizeTwitchChannelName } from '../../twitch/twitchChannelName';
import { isLockWaitTimeoutDbError } from './adminUserMutations';

const log = createLogger('Web');
const DISCORD_ID_RE = /^\d{17,20}$/;

export function discordIdError(id: string): string | null {
  return DISCORD_ID_RE.test(id) ? null : 'invalid_discord_id';
}

export function accessLevelError(levelStr: string): string | null {
  if (!/^\d+$/.test(levelStr)) return 'invalid_access_level';
  return (Object.values(AccessLevel) as number[]).includes(Number(levelStr)) ? null : 'invalid_access_level';
}

export function parseTwitchEnabled(val: string | undefined): boolean | null {
  if (val === 'true' || val === '1') return true;
  if (val === 'false' || val === '0') return false;
  return null;
}

export interface ParsedTwitchInput {
  error: string | null;
  normalizedTwitchName: string | null;
  shouldClearTwitchName: boolean;
}

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

export function handleDbError(err: unknown, res: Response, failCode: string, context: string): void {
  if (isLockWaitTimeoutDbError(err)) {
    log.warn(`${context} DB lock timeout`, err);
    res.redirect('/admin/users?error=db_busy');
  } else {
    log.error(`${context} error:`, err);
    res.redirect(`/admin/users?error=${failCode}`);
  }
}
