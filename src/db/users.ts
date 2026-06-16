import mysql from 'mysql2/promise';
import { normalizeTwitchChannelName } from '../twitch/twitchChannelName';
import { getPool } from './pool';
import { createLogger } from '../shared/logger';
import { fromBit } from './utils';

const log = createLogger('DB');

export const AccessLevel = {
  USER: 0,
  MOD: 1,
  MANAGER: 2,
  ADMIN: 3,
} as const;

export type AccessLevelValue = (typeof AccessLevel)[keyof typeof AccessLevel];

export const ACCESS_LEVEL_LABELS: Record<number, string> = {
  0: 'User',
  1: 'Mod',
  2: 'Manager',
  3: 'Admin',
};

export interface DbUser {
  discord_id: string;
  discord_name: string | null;
  is_twitch_bot_enabled: boolean;
  twitch_name: string | null;
  access_level: number;
  /** Bot-owner flag (global super-admin). Set only via direct DB access, never the web panel. */
  is_owner: boolean;
}

function mapUser(r: mysql.RowDataPacket): DbUser {
  return {
    discord_id: String(r.discord_id),
    discord_name: r.discord_name,
    is_twitch_bot_enabled: fromBit(r.is_twitch_bot_enabled),
    twitch_name: r.twitch_name,
    access_level: r.access_level,
    is_owner: fromBit(r.is_owner),
  };
}

export async function findUser(discordId: string): Promise<DbUser | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT discord_id, discord_name, is_twitch_bot_enabled, twitch_name, access_level, is_owner FROM `user` WHERE discord_id = ?',
    [discordId],
  );
  return rows.length === 0 ? null : mapUser(rows[0]);
}

export async function findUserByTwitchName(twitchName: string, excludeDiscordId?: string): Promise<DbUser | null> {
  const normalizedTwitchName = normalizeTwitchChannelName(twitchName);
  if (!normalizedTwitchName) {
    return null;
  }

  const sql = excludeDiscordId
    ? `SELECT discord_id, discord_name, is_twitch_bot_enabled, twitch_name, access_level, is_owner
       FROM \`user\`
       WHERE twitch_name = ?
         AND discord_id <> ?
       LIMIT 1`
    : `SELECT discord_id, discord_name, is_twitch_bot_enabled, twitch_name, access_level, is_owner
       FROM \`user\`
       WHERE twitch_name = ?
       LIMIT 1`;
  const params = excludeDiscordId
    ? [normalizedTwitchName, excludeDiscordId]
    : [normalizedTwitchName];
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(sql, params);
  return rows.length === 0 ? null : mapUser(rows[0]);
}

export async function getAllUsers(): Promise<DbUser[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT discord_id, discord_name, is_twitch_bot_enabled, twitch_name, access_level, is_owner FROM `user` ORDER BY access_level DESC, discord_name ASC',
  );
  return rows.map(mapUser);
}

/**
 * Returns the members of one guild as user records, with `access_level` sourced
 * from the per-guild `guild_member` row (not the legacy global column). Backs the
 * admin user list, which manages membership of the currently-selected guild.
 *
 * @param guildId Guild snowflake as a string.
 * @returns The guild's members, highest access level first.
 */
export async function getGuildMemberUsers(guildId: string): Promise<DbUser[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT u.discord_id, u.discord_name, u.is_twitch_bot_enabled, u.twitch_name,
            gm.access_level AS access_level, u.is_owner
     FROM guild_member gm
     JOIN \`user\` u ON u.discord_id = gm.discord_id
     WHERE gm.guild_id = ?
     ORDER BY gm.access_level DESC, u.discord_name ASC`,
    [guildId],
  );
  return rows.map(mapUser);
}

// Short timeout so callers fail fast instead of hanging 50s under lock contention.
async function withShortLockTimeout<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const connection = await getPool().getConnection();
  try {
    await connection.execute('SET SESSION innodb_lock_wait_timeout = 5');
    return await fn(connection);
  } finally {
    try { await connection.execute('SET SESSION innodb_lock_wait_timeout = DEFAULT'); } catch (e) {
      log.warn('connection.execute: failed to reset innodb_lock_wait_timeout to DEFAULT:', e);
    }
    connection.release();
  }
}

/**
 * Upserts a user record. Returns true when the twitchName field was included in the
 * call (even if null), so the caller can decide whether to invalidate any caches that
 * depend on Twitch channel assignments.
 */
export async function upsertUserRecord(
  discordId: string,
  discordName: string,
  accessLevel: number,
  twitchName?: string | null,
): Promise<boolean> {
  if (!(Object.values(AccessLevel) as number[]).includes(accessLevel)) {
    throw new Error(`Invalid accessLevel: ${accessLevel}`);
  }
  const trimmedDiscordName = discordName.trim() || null;
  const twitchNameProvided = twitchName !== undefined;
  const normalizedTwitchName = !twitchNameProvided
    ? null
    : twitchName === null
      ? null
      : (() => {
          const trimmedTwitchName = twitchName.trim();
          if (!trimmedTwitchName) {
            throw new Error(`Invalid twitchName: ${twitchName}`);
          }
          const normalizedChannelName = normalizeTwitchChannelName(trimmedTwitchName);
          if (!normalizedChannelName) {
            throw new Error(`Invalid twitchName: ${twitchName}`);
          }
          return normalizedChannelName;
        })();
  await withShortLockTimeout((conn) => conn.execute(
    `INSERT INTO \`user\` (discord_id, discord_name, access_level, twitch_name, is_twitch_bot_enabled)
     VALUES (?, ?, ?, ?, 0) AS new_user
     ON DUPLICATE KEY UPDATE discord_name = new_user.discord_name, access_level = new_user.access_level, twitch_name = IF(?, new_user.twitch_name, \`user\`.twitch_name)`,
    [discordId, trimmedDiscordName, accessLevel, normalizedTwitchName, twitchNameProvided ? 1 : 0],
  ));
  return twitchNameProvided;
}

export async function updateDiscordName(discordId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  await getPool().execute(
    'UPDATE `user` SET discord_name = ? WHERE discord_id = ?',
    [trimmed || null, discordId],
  );
}

export async function getTwitchEnabledChannels(): Promise<string[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT twitch_name
     FROM \`user\`
     WHERE is_twitch_bot_enabled = 1
       AND twitch_name IS NOT NULL
       AND twitch_name <> ''`,
  );
  return rows
    .map((r) => normalizeTwitchChannelName(String(r.twitch_name)))
    .filter((v): v is string => v !== null);
}

export async function setTwitchBotEnabledRecord(discordId: string, enabled: boolean): Promise<void> {
  await withShortLockTimeout((conn) => conn.execute(
    'UPDATE `user` SET is_twitch_bot_enabled = ? WHERE discord_id = ?',
    [enabled ? 1 : 0, discordId],
  ));
}

export async function updateAccessLevel(discordId: string, accessLevel: number): Promise<void> {
  if (!(Object.values(AccessLevel) as number[]).includes(accessLevel)) {
    throw new Error(`Invalid accessLevel: ${accessLevel}`);
  }
  await withShortLockTimeout((conn) => conn.execute(
    'UPDATE `user` SET access_level = ? WHERE discord_id = ?',
    [accessLevel, discordId],
  ));
}

export async function removeUserRecord(discordId: string): Promise<void> {
  await withShortLockTimeout((conn) => conn.execute(
    'DELETE FROM `user` WHERE discord_id = ?',
    [discordId],
  ));
}
