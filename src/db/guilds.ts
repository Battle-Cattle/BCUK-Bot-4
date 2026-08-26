import mysql from 'mysql2/promise';
import { getPool } from './pool';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A registered Discord guild (server) the bot serves, plus its per-guild config. */
export interface DbGuild {
  guild_id: string;
  name: string;
  /** Default voice channel for this guild; replaces the legacy DISCORD_VOICE_CHANNEL_ID env var. */
  voice_channel_id: string | null;
}

/** A guild the user is a member of, plus their access level there (from their `guild_member` row). */
export interface DbGuildMembership extends DbGuild {
  access_level: number;
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

// guild_id and voice_channel_id are BIGINT → strings (bigNumberStrings: true).
// Never coerce to Number — snowflakes lose precision.
function mapGuild(row: mysql.RowDataPacket): DbGuild {
  return {
    guild_id: String(row.guild_id),
    name: row.name,
    voice_channel_id: row.voice_channel_id === null ? null : String(row.voice_channel_id),
  };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Returns every registered guild, ordered by name. */
export async function getAllGuilds(): Promise<DbGuild[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT guild_id, name, voice_channel_id FROM guild ORDER BY name',
  );
  return rows.map(mapGuild);
}

/**
 * Returns the guilds the bot should actively serve: those with at least one
 * guild_member row. A bare `guild` row alone does not qualify.
 *
 * This is the "registered guild" set the in-memory registry loads. The
 * member-presence gate is what makes (un)registration durable: a guild
 * discovered via `guildCreate` (or re-inserted on reconnect) is inert until the
 * Owner provisions its first member, and removing every member durably stops the
 * bot serving it even though reconnects keep re-inserting the bare guild row.
 *
 * @returns Servable guilds ordered by name.
 */
export async function getProvisionedGuilds(): Promise<DbGuild[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT g.guild_id, g.name, g.voice_channel_id
     FROM guild g
     WHERE EXISTS (SELECT 1 FROM guild_member gm WHERE gm.guild_id = g.guild_id)
     ORDER BY g.name`,
  );
  return rows.map(mapGuild);
}

/**
 * Returns a single guild by its ID, or null if it is not found in the guild table.
 *
 * @param guildId BIGINT snowflake as a string.
 * @returns The guild row, or null if absent (including unprovisioned discovered guilds).
 */
export async function getGuildById(guildId: string): Promise<DbGuild | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT guild_id, name, voice_channel_id FROM guild WHERE guild_id = ? LIMIT 1',
    [guildId],
  );
  return rows.length === 0 ? null : mapGuild(rows[0]);
}

/**
 * Returns the guilds a user is a member of (one row per guild_member), ordered by name, each
 * paired with the user's access level in that guild. Used to build the web panel's guild
 * switcher for non-owner users; the included `access_level` lets callers resolve the current
 * guild's access level from this same result instead of a second `guild_member` query (see
 * `requireGuildContext` in `src/web/middleware.ts`).
 *
 * @param discordId BIGINT snowflake as a string.
 * @returns The user's member guilds with access level; empty if they belong to none.
 */
export async function getGuildsForMember(discordId: string): Promise<DbGuildMembership[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT g.guild_id, g.name, g.voice_channel_id, gm.access_level
     FROM guild g
     JOIN guild_member gm ON gm.guild_id = g.guild_id
     WHERE gm.discord_id = ?
     ORDER BY g.name`,
    [discordId],
  );
  return rows.map((row) => ({ ...mapGuild(row), access_level: row.access_level as number }));
}

// ─── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Inserts a guild row if it does not exist, otherwise refreshes its name.
 *
 * Insert-if-not-exists by design: `guildCreate` fires on every reconnect, not
 * just the first join, so this must never wipe existing per-guild config
 * (e.g. voice_channel_id). Only the display name is refreshed on conflict.
 *
 * @param guildId BIGINT snowflake as a string.
 * @param name Human-friendly server name.
 * @returns Resolves when the upsert is complete.
 */
export async function upsertGuild(guildId: string, name: string): Promise<void> {
  await getPool().execute(
    `INSERT INTO guild (guild_id, name) VALUES (?, ?) AS new_guild
     ON DUPLICATE KEY UPDATE name = new_guild.name`,
    [guildId, name],
  );
}
