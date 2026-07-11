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

const USER_SELECT = 'discord_id, discord_name, is_twitch_bot_enabled, twitch_name, access_level, is_owner';

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

/**
 * Look up a user by Discord ID.
 * @param discordId - Discord snowflake as a string.
 * @returns The matching user row, or null if no row exists.
 */
export async function findUser(discordId: string): Promise<DbUser | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${USER_SELECT} FROM \`user\` WHERE discord_id = ?`,
    [discordId],
  );
  return rows.length === 0 ? null : mapUser(rows[0]);
}

/**
 * Look up a user by their normalized Twitch channel name.
 * @param twitchName - Raw Twitch channel name input to normalize before matching.
 * @param excludeDiscordId - When set, excludes that Discord ID from the match (used when
 *   checking for a conflicting Twitch name during a different user's update).
 * @returns The matching user row, or null if no match is found or the name is invalid.
 */
export async function findUserByTwitchName(twitchName: string, excludeDiscordId?: string): Promise<DbUser | null> {
  const normalizedTwitchName = normalizeTwitchChannelName(twitchName);
  if (!normalizedTwitchName) {
    return null;
  }

  const sql = excludeDiscordId
    ? `SELECT ${USER_SELECT}
       FROM \`user\`
       WHERE twitch_name = ?
         AND discord_id <> ?
       LIMIT 1`
    : `SELECT ${USER_SELECT}
       FROM \`user\`
       WHERE twitch_name = ?
       LIMIT 1`;
  const params = excludeDiscordId
    ? [normalizedTwitchName, excludeDiscordId]
    : [normalizedTwitchName];
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(sql, params);
  return rows.length === 0 ? null : mapUser(rows[0]);
}

/**
 * Look up the bot owner's user row (the single global super-admin, `is_owner = 1`).
 * @returns The owner's user row, or null if no user is flagged as owner.
 */
export async function findOwnerUser(): Promise<DbUser | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${USER_SELECT} FROM \`user\` WHERE is_owner = 1 LIMIT 1`,
  );
  return rows.length === 0 ? null : mapUser(rows[0]);
}

/** Returns every user row, ordered by access level (highest first) then name. */
export async function getAllUsers(): Promise<DbUser[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${USER_SELECT} FROM \`user\` ORDER BY access_level DESC, discord_name ASC`,
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
 * Upserts a user record.
 * @param discordId - Discord snowflake as a string.
 * @param discordName - Display name to store; blank after trimming is stored as null.
 * @param accessLevel - Legacy global access level; must be one of `AccessLevel`'s values.
 * @param twitchName - Twitch channel name to set, or null to clear it; omit to leave unchanged.
 * @returns True when the twitchName field was included in the call (even if null), so the
 *   caller can decide whether to invalidate any caches that depend on Twitch channel assignments.
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

/**
 * Updates a user's stored Discord display name.
 * @param discordId - Discord snowflake as a string.
 * @param name - New display name; blank after trimming is stored as null.
 * @returns Resolves once the update completes.
 */
export async function updateDiscordName(discordId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  await getPool().execute(
    'UPDATE `user` SET discord_name = ? WHERE discord_id = ?',
    [trimmed || null, discordId],
  );
}

/**
 * Returns the normalized Twitch channel names of all users with the Twitch bot enabled.
 * @returns Normalized channel names; invalid/unparseable names are silently dropped.
 */
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

/** A user's normalized Twitch channel name paired with their Discord ID. */
export interface TwitchLinkedUser {
  twitchName: string;
  discordId: string;
}

/**
 * Returns every user with a linked Twitch channel name, for bulk-loading a
 * Twitch-channel → Discord-ID lookup cache. Unlike `getTwitchEnabledChannels`,
 * this is not filtered by `is_twitch_bot_enabled` — it matches the same
 * `twitch_name`-only lookup that `findUserByTwitchName` performs.
 * @returns Normalized channel names paired with their owner's Discord ID;
 *   invalid/unparseable names are silently dropped.
 */
export async function getAllTwitchLinkedUsers(): Promise<TwitchLinkedUser[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT discord_id, twitch_name
     FROM \`user\`
     WHERE twitch_name IS NOT NULL
       AND twitch_name <> ''`,
  );
  return rows
    .map((r) => {
      const twitchName = normalizeTwitchChannelName(String(r.twitch_name));
      return twitchName ? { twitchName, discordId: String(r.discord_id) } : null;
    })
    .filter((v): v is TwitchLinkedUser => v !== null);
}

/**
 * Sets whether a user's Twitch bot integration is enabled.
 * @param discordId - Discord snowflake as a string.
 * @param enabled - True to enable the Twitch bot for this user, false to disable it.
 * @returns Resolves once the update completes.
 */
export async function setTwitchBotEnabledRecord(discordId: string, enabled: boolean): Promise<void> {
  await withShortLockTimeout((conn) => conn.execute(
    'UPDATE `user` SET is_twitch_bot_enabled = ? WHERE discord_id = ?',
    [enabled ? 1 : 0, discordId],
  ));
}

/**
 * Updates a user's legacy global access level.
 * @param discordId - Discord snowflake as a string.
 * @param accessLevel - New access level; must be one of `AccessLevel`'s values.
 * @returns Resolves once the update completes.
 * @throws If `accessLevel` is not a valid `AccessLevel` value.
 */
export async function updateAccessLevel(discordId: string, accessLevel: number): Promise<void> {
  if (!(Object.values(AccessLevel) as number[]).includes(accessLevel)) {
    throw new Error(`Invalid accessLevel: ${accessLevel}`);
  }
  await withShortLockTimeout((conn) => conn.execute(
    'UPDATE `user` SET access_level = ? WHERE discord_id = ?',
    [accessLevel, discordId],
  ));
}

/**
 * Deletes a user record.
 * @param discordId - Discord snowflake as a string.
 * @returns Resolves once the deletion completes.
 */
export async function removeUserRecord(discordId: string): Promise<void> {
  await withShortLockTimeout((conn) => conn.execute(
    'DELETE FROM `user` WHERE discord_id = ?',
    [discordId],
  ));
}
