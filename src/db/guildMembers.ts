import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { AccessLevel, findUser, type DbUser } from './users';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A per-guild membership row: a user's access level within one specific guild. */
export interface DbGuildMember {
  guild_id: string;
  discord_id: string;
  access_level: number;
}

function mapGuildMember(row: mysql.RowDataPacket): DbGuildMember {
  return {
    guild_id: String(row.guild_id),
    discord_id: String(row.discord_id),
    access_level: row.access_level,
  };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Returns every membership row for a guild, ordered by access level descending.
 *
 * @param guildId - Guild snowflake ID.
 * @returns Array of guild member rows, highest access level first.
 */
export async function getGuildMembers(guildId: string): Promise<DbGuildMember[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT guild_id, discord_id, access_level
     FROM guild_member
     WHERE guild_id = ?
     ORDER BY access_level DESC`,
    [guildId],
  );
  return rows.map(mapGuildMember);
}

/**
 * Returns a user's access level within a specific guild, or null if they have no
 * membership row there. Reads the guild_member table directly.
 *
 * @param guildId - Guild snowflake ID.
 * @param discordId - User snowflake ID.
 * @returns The access level (0–3), or null if no membership row exists.
 */
export async function getMemberAccessLevel(guildId: string, discordId: string): Promise<number | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT access_level FROM guild_member WHERE guild_id = ? AND discord_id = ? LIMIT 1',
    [guildId, discordId],
  );
  return rows.length === 0 ? null : (rows[0].access_level as number);
}

// ─── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Sets (inserting or updating) a user's access level within a guild.
 *
 * @param guildId - Guild snowflake ID.
 * @param discordId - User snowflake ID.
 * @param accessLevel - One of the AccessLevel values (0–3); rejects invalid values.
 * @returns Resolves when the upsert is complete.
 */
export async function setMemberAccessLevel(guildId: string, discordId: string, accessLevel: number): Promise<void> {
  if (!(Object.values(AccessLevel) as number[]).includes(accessLevel)) {
    throw new Error(`Invalid accessLevel: ${accessLevel}`);
  }
  await getPool().execute(
    `INSERT INTO guild_member (guild_id, discord_id, access_level)
     VALUES (?, ?, ?) AS new_member
     ON DUPLICATE KEY UPDATE access_level = new_member.access_level`,
    [guildId, discordId, accessLevel],
  );
}

/**
 * Removes a user's membership row from a guild. No-op if no row exists.
 *
 * @param guildId - Guild snowflake ID.
 * @param discordId - User snowflake ID.
 * @returns Resolves when the delete is complete.
 */
export async function removeGuildMember(guildId: string, discordId: string): Promise<void> {
  await getPool().execute(
    'DELETE FROM guild_member WHERE guild_id = ? AND discord_id = ?',
    [guildId, discordId],
  );
}

// ─── Effective access-level resolution ─────────────────────────────────────────

/**
 * Resolves an already-fetched user's effective access level within a guild.
 *
 * Resolution order (PR 3): a bot owner (`user.is_owner`) is Admin everywhere
 * regardless of membership; otherwise the level comes from the user's
 * `guild_member` row for that guild, defaulting to User (0) when they have no
 * membership there. The web panel writes `guild_member` for the current guild,
 * so this is the single source of truth for authorization.
 *
 * Use this instead of {@link getEffectiveAccessLevel} when the caller already has
 * a fresh `DbUser` in hand (e.g. from its own `findUser` call moments earlier),
 * to avoid re-querying the same row.
 *
 * @param guildId Guild snowflake as a string.
 * @param user The user to resolve an access level for.
 * @returns The user's access level (0–3) for the guild.
 */
export async function getEffectiveAccessLevelForUser(guildId: string, user: DbUser): Promise<number> {
  if (user.is_owner) return AccessLevel.ADMIN;
  return (await getMemberAccessLevel(guildId, user.discord_id)) ?? AccessLevel.USER;
}

/**
 * Resolves a user's effective access level within a guild. A non-whitelisted user
 * (no `user` row) is User (0) — see {@link getEffectiveAccessLevelForUser} for the
 * resolution rules once a user row exists.
 *
 * @param guildId Guild snowflake as a string.
 * @param discordId User snowflake as a string.
 * @returns The user's access level (0–3) for the guild.
 */
export async function getEffectiveAccessLevel(guildId: string, discordId: string): Promise<number> {
  const user = await findUser(discordId);
  if (!user) return AccessLevel.USER;
  return getEffectiveAccessLevelForUser(guildId, user);
}
