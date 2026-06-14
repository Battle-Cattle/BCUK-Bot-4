import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { fromBit } from './utils';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A per-guild deviation from the global custom_command catalog.
 *
 * Sparse by design: a row exists only where a guild has changed something —
 * disabled the command for itself, or replaced its Discord output text. No row
 * means the guild uses the catalog default (enabled, catalog output). The Twitch
 * path never consults overrides.
 */
export interface DbGuildCommandOverride {
  guild_id: string;
  command_id: number;
  is_disabled: boolean;
  /** Per-guild replacement output; null means "use the catalog output". */
  output: string | null;
}

function mapOverride(row: mysql.RowDataPacket): DbGuildCommandOverride {
  return {
    guild_id: String(row.guild_id),
    command_id: row.command_id,
    is_disabled: fromBit(row.is_disabled),
    output: row.output,
  };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Returns every override row for a guild.
 *
 * @param guildId BIGINT snowflake as a string.
 * @returns All override rows for that guild; empty array if none exist.
 */
export async function getOverridesForGuild(guildId: string): Promise<DbGuildCommandOverride[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT guild_id, command_id, is_disabled, output FROM guild_command_override WHERE guild_id = ?',
    [guildId],
  );
  return rows.map(mapOverride);
}

/**
 * Returns every override row across all guilds (used to build the per-guild overlay cache).
 *
 * @returns All override rows for all guilds; empty array if none exist.
 */
export async function getAllOverrides(): Promise<DbGuildCommandOverride[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT guild_id, command_id, is_disabled, output FROM guild_command_override',
  );
  return rows.map(mapOverride);
}

// ─── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Inserts or updates a guild's override for a catalog command.
 *
 * @param guildId BIGINT snowflake as a string.
 * @param commandId The catalog command's command_id.
 * @param override.isDisabled When true, the command does not fire in this guild.
 * @param override.output Replacement Discord output, or null to use the catalog output.
 * @returns Resolves when the upsert is complete.
 */
export async function upsertOverride(
  guildId: string,
  commandId: number,
  override: { isDisabled: boolean; output: string | null },
): Promise<void> {
  await getPool().execute(
    `INSERT INTO guild_command_override (guild_id, command_id, is_disabled, output)
     VALUES (?, ?, ?, ?) AS new_override
     ON DUPLICATE KEY UPDATE is_disabled = new_override.is_disabled, output = new_override.output`,
    [guildId, commandId, override.isDisabled ? 1 : 0, override.output],
  );
}

/**
 * Removes a guild's override for a command, reverting it to the catalog default. No-op if absent.
 *
 * @param guildId BIGINT snowflake as a string.
 * @param commandId The catalog command's command_id.
 * @returns Resolves when the delete is complete.
 */
export async function removeOverride(guildId: string, commandId: number): Promise<void> {
  await getPool().execute(
    'DELETE FROM guild_command_override WHERE guild_id = ? AND command_id = ?',
    [guildId, commandId],
  );
}
