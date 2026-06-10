import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { fromBit } from './utils';
import { AccessLevel } from './users';
import type { AccessLevelValue } from './users';
import { assertNotReservedCommand } from './reservedCommands';
import { requireTrimmedString, CommandNotFoundError, type SqlExecutor } from './commandStringUtils';
import { acquireNamedLock, releaseNamedLock, commandExists, runSerializedCommandWrite } from './commandLocks';
import {
  assertDiscordTriggerAvailable, assertMultiTwitchTriggerAvailable, assertNoSingleTwitchAssignmentOverlap,
  assignUserToCommandWithinTransaction,
} from './commandConflicts';
import { invalidateCustomCommandLookupCache } from './customCommandCache';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A custom command row from the database. */
export interface DbCustomCommand {
  command_id: number;
  trigger_string: string;
  output: string;
  is_discord_enabled: boolean;
  is_multi_twitch: boolean;
}

/** A user assigned to a custom command (may be orphaned if their account no longer exists). */
export interface DbCustomCommandAssignedUser {
  discord_id: string;
  discord_name: string | null;
  twitch_name: string | null;
  access_level: AccessLevelValue;
  is_twitch_bot_enabled: boolean;
  is_orphaned_user: boolean;
}

/** A custom command with its full list of assigned users. */
export interface DbCustomCommandWithAssignments extends DbCustomCommand {
  assigned_users: DbCustomCommandAssignedUser[];
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

function mapCustomCommand(row: mysql.RowDataPacket): DbCustomCommand {
  return {
    command_id: row.command_id,
    trigger_string: row.trigger_string,
    output: row.output,
    is_discord_enabled: fromBit(row.is_discord_enabled),
    is_multi_twitch: fromBit(row.is_multi_twitch),
  };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Return all custom commands, each with its full list of assigned users. */
export async function getAllCustomCommandsWithAssignments(): Promise<DbCustomCommandWithAssignments[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT c.command_id, c.trigger_string, c.output, c.is_discord_enabled, c.is_multi_twitch,
            tuc.discord_id AS assigned_discord_id,
            u.discord_id AS user_discord_id,
            u.discord_name, u.twitch_name, u.access_level, u.is_twitch_bot_enabled
     FROM custom_command c
     LEFT JOIN twitch_user_commands tuc ON c.command_id = tuc.command_id
     LEFT JOIN \`user\` u ON tuc.discord_id = u.discord_id
     ORDER BY c.trigger_string, u.discord_name, tuc.discord_id`,
  );

  const commandMap = new Map<number, DbCustomCommandWithAssignments>();

  for (const row of rows) {
    if (!commandMap.has(row.command_id)) {
      commandMap.set(row.command_id, {
        ...mapCustomCommand(row),
        assigned_users: [],
      });
    }

    if (row.assigned_discord_id !== null && row.assigned_discord_id !== undefined) {
      commandMap.get(row.command_id)!.assigned_users.push({
        discord_id: String(row.assigned_discord_id),
        discord_name: row.discord_name ?? null,
        twitch_name: row.twitch_name ?? null,
        access_level: row.access_level ?? AccessLevel.USER,
        is_twitch_bot_enabled: fromBit(row.is_twitch_bot_enabled),
        is_orphaned_user: row.user_discord_id === null || row.user_discord_id === undefined,
      });
    }
  }

  return Array.from(commandMap.values());
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Create a new custom command. Validates and normalises the trigger string, checks for
 * conflicts, and invalidates the lookup cache on success.
 *
 * @param triggerString - Full prefixed command string (e.g. `!clap`); lowercased before storing.
 * @param output - Response text, max 2000 characters.
 * @param isDiscordEnabled - When true, the command responds in Discord.
 * @param isMultiTwitch - When true, the command can be assigned to multiple Twitch streamers.
 * @returns The auto-incremented `command_id` of the newly created row.
 */
export async function addCustomCommand(
  triggerString: string,
  output: string,
  isDiscordEnabled: boolean,
  isMultiTwitch: boolean,
): Promise<number> {
  const normalizedTriggerString = requireTrimmedString(triggerString, 'trigger_string', 255).toLowerCase();
  const normalizedOutput = requireTrimmedString(output, 'output', 2000);

  assertNotReservedCommand(normalizedTriggerString);

  const commandId = await runSerializedCommandWrite(
    normalizedTriggerString,
    undefined,
    async (connection) => {
      if (isDiscordEnabled) {
        await assertDiscordTriggerAvailable(normalizedTriggerString, connection);
      }

      if (isMultiTwitch) {
        await assertMultiTwitchTriggerAvailable(connection, normalizedTriggerString);
      }

      const [result] = await connection.execute<mysql.ResultSetHeader>(
        `INSERT INTO custom_command (trigger_string, output, is_discord_enabled, is_multi_twitch)
         VALUES (?, ?, ?, ?)`,
        [normalizedTriggerString, normalizedOutput, isDiscordEnabled ? 1 : 0, isMultiTwitch ? 1 : 0],
      );

      return result.insertId;
    },
    { includeCustomCommandTable: false, includeCounterTable: true },
  );

  invalidateCustomCommandLookupCache();

  return commandId;
}

/**
 * Update an existing custom command's trigger string, output, and flags.
 * Validates conflicts against other commands, throws {@link CommandNotFoundError}
 * if the command does not exist, and invalidates the lookup cache on success.
 *
 * @param commandId - ID of the command to update.
 * @param triggerString - New trigger string; lowercased before storing.
 * @param output - New response text, max 2000 characters.
 * @param isDiscordEnabled - Whether the command responds in Discord.
 * @param isMultiTwitch - Whether the command can be assigned to multiple Twitch streamers.
 */
export async function updateCustomCommand(
  commandId: number,
  triggerString: string,
  output: string,
  isDiscordEnabled: boolean,
  isMultiTwitch: boolean,
): Promise<void> {
  const normalizedTriggerString = requireTrimmedString(triggerString, 'trigger_string', 255).toLowerCase();
  const normalizedOutput = requireTrimmedString(output, 'output', 2000);

  assertNotReservedCommand(normalizedTriggerString);

  await runSerializedCommandWrite(
    normalizedTriggerString,
    { excludeCustomCommandId: commandId },
    async (connection) => {
      if (isDiscordEnabled) {
        await assertDiscordTriggerAvailable(normalizedTriggerString, connection, commandId);
      }

      if (isMultiTwitch) {
        await assertMultiTwitchTriggerAvailable(connection, normalizedTriggerString, commandId);
      } else {
        await assertNoSingleTwitchAssignmentOverlap(connection, commandId, normalizedTriggerString);
      }

      const [result] = await connection.execute<mysql.ResultSetHeader>(
        `UPDATE custom_command
         SET trigger_string = ?, output = ?, is_discord_enabled = ?, is_multi_twitch = ?
         WHERE command_id = ?`,
        [normalizedTriggerString, normalizedOutput, isDiscordEnabled ? 1 : 0, isMultiTwitch ? 1 : 0, commandId],
      );

      if (result.affectedRows === 0 && !(await commandExists(commandId, connection))) {
        throw new CommandNotFoundError(commandId);
      }
    },
    { includeCustomCommandTable: false, includeCounterTable: true },
  );

  invalidateCustomCommandLookupCache();
}

/**
 * Delete a custom command and all its user assignments within a transaction.
 * Throws {@link CommandNotFoundError} if the command does not exist.
 * Invalidates the lookup cache only after a successful commit.
 *
 * @param commandId - ID of the command to delete.
 */
export async function removeCustomCommand(commandId: number): Promise<void> {
  const connection = await getPool().getConnection();
  const lockName = `bcuk_cmdid_${commandId}`;

  try {
    await acquireNamedLock(connection, lockName);
    await connection.beginTransaction();
    await connection.execute(
      'DELETE FROM twitch_user_commands WHERE command_id = ?',
      [commandId],
    );
    const [result] = await connection.execute<mysql.ResultSetHeader>(
      'DELETE FROM custom_command WHERE command_id = ?',
      [commandId],
    );
    if (result.affectedRows === 0) {
      throw new CommandNotFoundError(commandId);
    }
    await connection.commit();
    // Invalidate only after a successful commit; refresh remains lazy on next lookup.
    invalidateCustomCommandLookupCache();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await releaseNamedLock(connection, lockName);
    connection.release();
  }
}

/**
 * Assign a Discord user to a custom command's Twitch streamer list.
 * Acquires a named lock for the command ID, then delegates to
 * {@link assignUserToCommandWithinTransaction} to check cross-command conflicts
 * before inserting. Invalidates the lookup cache on success.
 *
 * @param commandId - ID of the command to assign the user to.
 * @param discordId - Discord snowflake of the user to assign.
 */
export async function assignUserToCommand(commandId: number, discordId: string): Promise<void> {
  const connection = await getPool().getConnection();

  const lockNameById = `bcuk_cmdid_${commandId}`;
  try {
    // The outer assignUserToCommand lock serializes writes for one command id.
    // assignUserToCommandWithinTransaction then re-reads the trigger via
    // getCommandTriggerStringById, derives lockNameByTrigger, and acquires the
    // session-scoped trigger lock so cross-command trigger conflicts are checked
    // against the latest trigger string before inserting the assignment.
    await acquireNamedLock(connection, lockNameById);

    await assignUserToCommandWithinTransaction(connection, commandId, discordId);

    // Invalidate only after commit; keep lock ownership and connection lifecycle deterministic.
    invalidateCustomCommandLookupCache();
  } finally {
    // Always release the id lock
    await releaseNamedLock(connection, lockNameById);
    connection.release();
  }
}

/**
 * Remove a Discord user's assignment from a custom command and invalidate the lookup cache.
 *
 * @param commandId - ID of the command to remove the assignment from.
 * @param discordId - Discord snowflake of the user to unassign.
 */
export async function unassignUserFromCommand(commandId: number, discordId: string): Promise<void> {
  await getPool().execute(
    'DELETE FROM twitch_user_commands WHERE command_id = ? AND discord_id = ?',
    [commandId, discordId],
  );

  invalidateCustomCommandLookupCache();
}

// Unused in this module but exported so commandLocks.ts helpers remain type-safe
// when callers import SqlExecutor from db.ts for their own executors.
export type { SqlExecutor };
