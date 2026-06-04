import { Response } from 'express';
import { createLogger } from '../../shared/logger';
import { findUser, AccessLevel } from '../../db';
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

export async function checkManagerEditAuth(
  sessionUser: { discordId: string; accessLevel: number },
  targetDiscordId: string,
  targetLevel: number,
): Promise<string | null> {
  if (targetDiscordId === sessionUser.discordId) return 'self_edit_forbidden';
  if (sessionUser.accessLevel < AccessLevel.ADMIN) {
    if (targetLevel >= sessionUser.accessLevel) return 'access_level_too_high';
    const existingUser = await findUser(targetDiscordId);
    if (existingUser && existingUser.access_level >= sessionUser.accessLevel) return 'target_above_level';
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
