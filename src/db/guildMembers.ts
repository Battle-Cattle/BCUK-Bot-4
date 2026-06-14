import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { AccessLevel, findUser } from './users';

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

// ─── Effective access-level shim ───────────────────────────────────────────────

/**
 * Resolves a user's effective access level for a guild.
 *
 * COMPATIBILITY SHIM (PR 2): while only one guild exists and the web panel still
 * writes the legacy `user.access_level` column, this returns that legacy value so
 * every existing reader keeps behaving identically. It deliberately does NOT read
 * `guild_member` yet — that table is seeded from `access_level` at migration time
 * but would drift the moment an admin changes a level through the current UI.
 *
 * PR 3 flips the source to `guild_member` (per-guild) and adds the `is_owner`
 * short-circuit once the readers and the admin UI are migrated together.
 *
 * @param _guildId Accepted now so callers can thread guildId through; unused until PR 3.
 * @param discordId BIGINT snowflake as a string.
 * @returns The user's access level, or AccessLevel.USER (0) if they have no user row.
 */
export async function getEffectiveAccessLevel(_guildId: string, discordId: string): Promise<number> {
  const user = await findUser(discordId);
  return user ? user.access_level : AccessLevel.USER;
}
