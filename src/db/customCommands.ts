import mysql from 'mysql2/promise';
import { getPool, runInTransaction } from './pool';
import { fromBit, getRowCount } from './utils';
import { getOrCreate } from '../shared/mapUtils';
import { AccessLevel } from './users';
import type { AccessLevelValue } from './users';
import { assertNotReservedCommand } from './reservedCommands';
import { requireTrimmedString, CommandNotFoundError, CommandSelfServiceDeniedError, type SqlExecutor } from './commandStringUtils';
import { isCommandSelfManageableBy, isCommandUnclaimedBy } from './commandSelfService';
import { acquireNamedLock, releaseNamedLock, commandExists, runSerializedCommandWrite } from './commandLocks';
import {
  assertDiscordTriggerAvailable, assertMultiTwitchTriggerAvailable, assertNoSingleTwitchAssignmentOverlap,
  assignUserToCommandWithinTransaction, assignUsersToCommandWithinTransaction,
} from './commandConflicts';

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

/**
 * Maps a `custom_commands` row to a {@link DbCustomCommand}, converting BIT columns to booleans.
 * @param row - Raw row from mysql2.
 * @returns The mapped command.
 */
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

/** Return the total number of custom commands, for the dashboard's usage-stats summary. */
export async function getCustomCommandCount(): Promise<number> {
  return getRowCount('custom_command');
}

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
    const commandEntry = getOrCreate(commandMap, row.command_id, () => ({
      ...mapCustomCommand(row),
      assigned_users: [],
    }));

    if (row.assigned_discord_id !== null && row.assigned_discord_id !== undefined) {
      commandEntry.assigned_users.push({
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

// ─── Streamer self-service ────────────────────────────────────────────────────

/** A streamer-ownership rule checked under lock: the streamer, and the predicate their write needs. */
interface OwnershipCheck {
  discordId: string;
  /** {@link isCommandSelfManageableBy} for edits/deletes, {@link isCommandUnclaimedBy} for failed-create cleanup. */
  allows: typeof isCommandSelfManageableBy;
}

/**
 * Re-checks a streamer-ownership rule inside the caller's transaction, locking the command row and
 * its assignment rows (`SELECT … FOR UPDATE`) so a concurrent assignment or flag change can't land
 * between this check and the caller's write: it either commits first and is seen here, or waits
 * for this transaction to finish.
 * @param connection - Connection with an open transaction.
 * @param commandId - ID of the command being changed.
 * @param check - The streamer and the rule their write must satisfy.
 * @throws {CommandNotFoundError} If the command doesn't exist.
 * @throws {CommandSelfServiceDeniedError} If the rule doesn't hold.
 */
async function assertOwnershipWithinTransaction(
  connection: SqlExecutor,
  commandId: number,
  check: OwnershipCheck,
): Promise<void> {
  const [commandRows] = await connection.execute<mysql.RowDataPacket[]>(
    'SELECT is_discord_enabled, is_multi_twitch FROM custom_command WHERE command_id = ? FOR UPDATE',
    [commandId],
  );
  const commandRow = commandRows[0];
  if (!commandRow) throw new CommandNotFoundError(commandId);

  const [assignmentRows] = await connection.execute<mysql.RowDataPacket[]>(
    'SELECT discord_id FROM twitch_user_commands WHERE command_id = ? FOR UPDATE',
    [commandId],
  );
  const flags = {
    is_discord_enabled: fromBit(commandRow.is_discord_enabled),
    is_multi_twitch: fromBit(commandRow.is_multi_twitch),
  };
  const assignedDiscordIds = assignmentRows.map((row) => String(row.discord_id));
  if (!check.allows(flags, assignedDiscordIds, check.discordId)) {
    throw new CommandSelfServiceDeniedError(commandId);
  }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Create a new custom command. Validates and normalises the trigger string, checks for
 * conflicts.
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

  return commandId;
}

/** A custom command's editable fields, as written by {@link writeCustomCommandUpdate}. */
interface CustomCommandFields {
  triggerString: string;
  output: string;
  isDiscordEnabled: boolean;
  isMultiTwitch: boolean;
}

/**
 * Shared body of {@link updateCustomCommand} and {@link updateOwnCustomCommand}: validates the
 * trigger, then — holding the command's id lock and, inside that, the trigger's command-write lock,
 * in one transaction — optionally re-checks streamer ownership, checks conflicts and writes the row.
 * @param commandId - ID of the command to update.
 * @param fields - New trigger (lowercased before storing), output (max 2000 characters) and flags.
 * @param selfServiceDiscordId - When set, the update only goes ahead if this streamer owns the
 *   command outright, checked inside the transaction ({@link assertOwnershipWithinTransaction}).
 */
async function writeCustomCommandUpdate(
  commandId: number,
  fields: CustomCommandFields,
  selfServiceDiscordId?: string,
): Promise<void> {
  const normalizedTriggerString = requireTrimmedString(fields.triggerString, 'trigger_string', 255).toLowerCase();
  const normalizedOutput = requireTrimmedString(fields.output, 'output', 2000);

  assertNotReservedCommand(normalizedTriggerString);

  // Hold the command's id lock (the one assignUserToCommand/assignUsersToCommand take first) for
  // the whole update, so a concurrent assignment can't validate the old trigger and then insert
  // after a rename commits: it either finishes first or waits and reads the new trigger. Same
  // id-then-trigger lock order as assignment, so the two can't deadlock. The trigger-locked write
  // runs on this same connection, so an update never holds one pool connection while waiting
  // for a second.
  const idLockConnection = await getPool().getConnection();
  const idLockName = `bcuk_cmdid_${commandId}`;
  try {
    await acquireNamedLock(idLockConnection, idLockName);
    await writeCustomCommandRow(idLockConnection, commandId, { normalizedTriggerString, normalizedOutput, fields }, selfServiceDiscordId);
  } finally {
    await releaseNamedLock(idLockConnection, idLockName);
    idLockConnection.release();
  }
}

/**
 * The trigger-locked part of {@link writeCustomCommandUpdate}: on the caller's connection (which
 * already holds the command's id lock), in one transaction, optionally re-checks streamer
 * ownership, checks conflicts and writes the row.
 * @param connection - The connection holding the command's id lock; the caller releases it.
 * @param commandId - ID of the command to update.
 * @param row - The validated, lowercased trigger, the validated output, and the flags to write.
 * @param row.normalizedTriggerString - Validated, lowercased trigger.
 * @param row.normalizedOutput - Validated output.
 * @param row.fields - The Discord/multi-Twitch flags to write.
 * @param selfServiceDiscordId - When set, the streamer who must own the command outright.
 */
async function writeCustomCommandRow(
  connection: mysql.PoolConnection,
  commandId: number,
  row: {
    normalizedTriggerString: string;
    normalizedOutput: string;
    fields: Pick<CustomCommandFields, 'isDiscordEnabled' | 'isMultiTwitch'>;
  },
  selfServiceDiscordId?: string,
): Promise<void> {
  const { normalizedTriggerString, normalizedOutput } = row;
  const { isDiscordEnabled, isMultiTwitch } = row.fields;
  await runSerializedCommandWrite(
    normalizedTriggerString,
    { excludeCustomCommandId: commandId, connection },
    async (connection) => {
      if (selfServiceDiscordId !== undefined) {
        await assertOwnershipWithinTransaction(connection, commandId, { discordId: selfServiceDiscordId, allows: isCommandSelfManageableBy });
      }

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
}

/**
 * Update an existing custom command's trigger string, output, and flags.
 * Validates conflicts against other commands, throws {@link CommandNotFoundError}
 * if the command does not exist.
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
  await writeCustomCommandUpdate(commandId, { triggerString, output, isDiscordEnabled, isMultiTwitch });
}

/**
 * Streamer self-service update: changes a command's trigger and output, keeping it Twitch-only
 * (Discord and multi-Twitch off), but only if `discordId` owns it outright — re-checked inside the
 * update's own transaction, so a concurrent assignment or flag change can't slip in between.
 *
 * @param commandId - ID of the command to update.
 * @param triggerString - New trigger string; lowercased before storing.
 * @param output - New response text, max 2000 characters.
 * @param discordId - Discord ID of the streamer making the change.
 * @throws {CommandNotFoundError} If the command doesn't exist.
 * @throws {CommandSelfServiceDeniedError} If the streamer doesn't own it outright.
 */
export async function updateOwnCustomCommand(
  commandId: number,
  triggerString: string,
  output: string,
  discordId: string,
): Promise<void> {
  await writeCustomCommandUpdate(
    commandId, { triggerString, output, isDiscordEnabled: false, isMultiTwitch: false }, discordId,
  );
}

/**
 * Shared body of {@link removeCustomCommand}, {@link removeOwnCustomCommand} and
 * {@link discardOwnNewCustomCommand}: under the command's id lock, in one transaction, optionally
 * re-checks a streamer-ownership rule, then deletes the command and its assignments.
 * @param commandId - ID of the command to delete.
 * @param check - When set, the delete only goes ahead (and deletes nothing otherwise) if this
 *   rule holds, checked inside the transaction.
 */
async function deleteCustomCommand(commandId: number, check?: OwnershipCheck): Promise<void> {
  const connection = await getPool().getConnection();
  const lockName = `bcuk_cmdid_${commandId}`;

  try {
    await acquireNamedLock(connection, lockName);
    await runInTransaction(connection, async () => {
      if (check !== undefined) {
        await assertOwnershipWithinTransaction(connection, commandId, check);
      }
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
    });
  } finally {
    await releaseNamedLock(connection, lockName);
    connection.release();
  }
}

/**
 * Delete a custom command and all its user assignments within a transaction.
 * Throws {@link CommandNotFoundError} if the command does not exist.
 *
 * @param commandId - ID of the command to delete.
 */
export async function removeCustomCommand(commandId: number): Promise<void> {
  await deleteCustomCommand(commandId);
}

/**
 * Streamer self-service delete: deletes a command only if `discordId` owns it outright, re-checked
 * inside the delete's own transaction. Deletes nothing when denied.
 *
 * @param commandId - ID of the command to delete.
 * @param discordId - Discord ID of the streamer making the change.
 * @throws {CommandNotFoundError} If the command doesn't exist.
 * @throws {CommandSelfServiceDeniedError} If the streamer doesn't own it outright.
 */
export async function removeOwnCustomCommand(commandId: number, discordId: string): Promise<void> {
  await deleteCustomCommand(commandId, { discordId, allows: isCommandSelfManageableBy });
}

/**
 * Cleans up a streamer's just-created command after its self-assignment failed, but only while
 * it is still unclaimed ({@link isCommandUnclaimedBy}), re-checked inside the delete's own
 * transaction. If a Mod adopted it in the meantime, it is left in place.
 *
 * @param commandId - ID of the command to discard.
 * @param discordId - Discord ID of the streamer who created it.
 * @throws {CommandNotFoundError} If the command doesn't exist.
 * @throws {CommandSelfServiceDeniedError} If a Mod has since adopted it.
 */
export async function discardOwnNewCustomCommand(commandId: number, discordId: string): Promise<void> {
  await deleteCustomCommand(commandId, { discordId, allows: isCommandUnclaimedBy });
}

/**
 * Assign a Discord user to a custom command's Twitch streamer list.
 * Acquires a named lock for the command ID, then delegates to
 * {@link assignUserToCommandWithinTransaction} to check cross-command conflicts
 * before inserting.
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
  } finally {
    // Always release the id lock
    await releaseNamedLock(connection, lockNameById);
    connection.release();
  }
}

/**
 * Assign multiple Discord users to a custom command's Twitch streamer list in one transaction.
 * Acquires the command ID's named lock once, then delegates to
 * {@link assignUsersToCommandWithinTransaction} to check cross-command conflicts and insert all
 * assignments. A no-op (no connection opened) when `discordIds` is empty.
 *
 * @param commandId - ID of the command to assign the users to.
 * @param discordIds - Discord snowflakes of the users to assign.
 */
export async function assignUsersToCommand(commandId: number, discordIds: string[]): Promise<void> {
  if (discordIds.length === 0) return;

  const connection = await getPool().getConnection();

  const lockNameById = `bcuk_cmdid_${commandId}`;
  try {
    await acquireNamedLock(connection, lockNameById);

    await assignUsersToCommandWithinTransaction(connection, commandId, discordIds);
  } finally {
    await releaseNamedLock(connection, lockNameById);
    connection.release();
  }
}

/**
 * Remove a Discord user's assignment from a custom command.
 *
 * @param commandId - ID of the command to remove the assignment from.
 * @param discordId - Discord snowflake of the user to unassign.
 */
export async function unassignUserFromCommand(commandId: number, discordId: string): Promise<void> {
  await getPool().execute(
    'DELETE FROM twitch_user_commands WHERE command_id = ? AND discord_id = ?',
    [commandId, discordId],
  );
}

// Unused in this module but exported so commandLocks.ts helpers remain type-safe
// when callers import SqlExecutor from db.ts for their own executors.
export type { SqlExecutor };
