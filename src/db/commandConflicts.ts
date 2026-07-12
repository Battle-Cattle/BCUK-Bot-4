import { createLogger } from '../shared/logger';
import mysql from 'mysql2/promise';

const log = createLogger('DB');
import { normalizeTwitchChannelName } from '../twitch/twitchChannelName';
import { type SqlExecutor, CommandConflictError, normalizeCommand } from './commandStringUtils';
import {
  acquireNamedLock,
  releaseNamedLock,
  getCommandWriteLockName,
  isDeadlockError,
  MAX_DEADLOCK_RETRIES,
} from './commandLocks';
import { fromBit } from './utils';

// ─── Conflict assertions ──────────────────────────────────────────────────────

/**
 * Throws if a Discord-enabled custom command already uses `triggerString`.
 * @param triggerString Trigger string to check for conflicts.
 * @param executor Pool or transaction connection to query with.
 * @param excludeCommandId Command id to exclude from the conflict check (e.g. the command being edited).
 * @throws {CommandConflictError} If a conflicting Discord-enabled command exists.
 */
export async function assertDiscordTriggerAvailable(
  triggerString: string,
  executor: SqlExecutor,
  excludeCommandId?: number,
): Promise<void> {
  let sql =
    `SELECT command_id
     FROM custom_command
     WHERE trigger_string = ?
       AND is_discord_enabled = 1`;
  const params: Array<string | number> = [triggerString];

  if (excludeCommandId !== undefined) {
    sql += ' AND command_id <> ?';
    params.push(excludeCommandId);
  }

  sql += ' LIMIT 1';

  const [conflictRows] = await executor.execute<mysql.RowDataPacket[]>(sql, params);
  if (conflictRows.length > 0) {
    throw new CommandConflictError([triggerString]);
  }
}

/**
 * Checks whether `triggerString` is already used by a multi-Twitch command, or by a command
 * assigned to a user whose Twitch bot is enabled.
 * @param executor Pool or transaction connection to query with.
 * @param triggerString Trigger string to check for conflicts.
 * @param excludeCommandId Command id to exclude from the conflict check.
 * @returns True if a conflicting command exists.
 */
async function hasMultiTwitchTriggerConflict(
  executor: SqlExecutor,
  triggerString: string,
  excludeCommandId?: number,
): Promise<boolean> {
  const wherePrefix = excludeCommandId !== undefined
    ? 'WHERE c.command_id <> ? AND c.trigger_string = ?'
    : 'WHERE c.trigger_string = ?';
  const params: Array<string | number> = excludeCommandId !== undefined
    ? [excludeCommandId, triggerString]
    : [triggerString];

  const [conflictRows] = await executor.execute<mysql.RowDataPacket[]>(
    `SELECT c.command_id
     FROM custom_command c
     LEFT JOIN twitch_user_commands tuc ON tuc.command_id = c.command_id
     LEFT JOIN \`user\` u ON u.discord_id = tuc.discord_id
     ${wherePrefix}
       AND (
         c.is_multi_twitch = 1
         OR (
           u.twitch_name IS NOT NULL
           AND u.is_twitch_bot_enabled = 1
         )
       )
     LIMIT 1`,
    params,
  );

  return conflictRows.length > 0;
}

/**
 * Throws if `triggerString` is already used by a multi-Twitch command, or by a command
 * assigned to a user whose Twitch bot is enabled.
 * @param executor Pool or transaction connection to query with.
 * @param triggerString Trigger string to check for conflicts.
 * @param excludeCommandId Command id to exclude from the conflict check.
 * @throws {CommandConflictError} If a conflicting command exists.
 */
export async function assertMultiTwitchTriggerAvailable(
  executor: SqlExecutor,
  triggerString: string,
  excludeCommandId?: number,
): Promise<void> {
  if (await hasMultiTwitchTriggerConflict(executor, triggerString, excludeCommandId)) {
    throw new CommandConflictError([triggerString]);
  }
}

/**
 * Checks whether assigning `triggerString` to the command's existing single-Twitch users would
 * overlap with another command already covering the same Twitch channel (or a multi-Twitch command).
 * @param executor Pool or transaction connection to query with.
 * @param commandId Command id whose Twitch-enabled assignees are checked for overlap.
 * @param triggerString Trigger string being assigned.
 * @returns True if an overlapping assignment exists.
 */
async function hasSingleTwitchAssignmentOverlap(
  executor: SqlExecutor,
  commandId: number,
  triggerString: string,
): Promise<boolean> {
  const [overlapRows] = await executor.execute<mysql.RowDataPacket[]>(
    `SELECT other.command_id
     FROM twitch_user_commands current_tuc
     JOIN \`user\` current_u ON current_u.discord_id = current_tuc.discord_id
     JOIN custom_command other
       ON other.command_id <> ?
      AND other.trigger_string = ?
     LEFT JOIN twitch_user_commands other_tuc ON other_tuc.command_id = other.command_id
     LEFT JOIN \`user\` other_u ON other_u.discord_id = other_tuc.discord_id
     WHERE current_tuc.command_id = ?
       AND current_u.twitch_name IS NOT NULL
       AND current_u.is_twitch_bot_enabled = 1
       AND (
         other.is_multi_twitch = 1
         OR (
           other_u.twitch_name IS NOT NULL
           AND other_u.is_twitch_bot_enabled = 1
           AND LOWER(other_u.twitch_name) = LOWER(current_u.twitch_name)
         )
       )
     LIMIT 1`,
    [commandId, triggerString, commandId],
  );

  return overlapRows.length > 0;
}

/**
 * Throws if assigning `triggerString` to the command's existing single-Twitch users would
 * overlap with another command already covering the same Twitch channel (or a multi-Twitch command).
 * @param executor Pool or transaction connection to query with.
 * @param commandId Command id whose Twitch-enabled assignees are checked for overlap.
 * @param triggerString Trigger string being assigned.
 * @throws {CommandConflictError} If an overlapping assignment exists.
 */
export async function assertNoSingleTwitchAssignmentOverlap(
  executor: SqlExecutor,
  commandId: number,
  triggerString: string,
): Promise<void> {
  if (await hasSingleTwitchAssignmentOverlap(executor, commandId, triggerString)) {
    throw new CommandConflictError([triggerString]);
  }
}

/**
 * Looks up a custom command's trigger string by its id, normalized (trimmed, lowercased).
 * @param executor Pool or transaction connection to query with.
 * @param commandId Primary key of the `custom_command` row.
 * @returns The normalized trigger string.
 * @throws If no command exists with the given id.
 */
export async function getCommandTriggerStringById(executor: SqlExecutor, commandId: number): Promise<string> {
  const [commandRows] = await executor.execute<mysql.RowDataPacket[]>(
    'SELECT trigger_string FROM custom_command WHERE command_id = ? LIMIT 1',
    [commandId],
  );
  if (commandRows.length === 0) {
    throw new Error(`Custom command not found: ${commandId}`);
  }

  return normalizeCommand(String(commandRows[0].trigger_string)) ?? '';
}

interface UserTwitchEligibility {
  normalizedTwitchName: string | null;
  isTwitchBotEnabled: boolean;
}

/**
 * Looks up a user's normalized Twitch channel name and Twitch-bot-enabled flag, used to
 * decide whether a Twitch-channel trigger conflict check applies to them.
 * @param executor Pool or transaction connection to query with.
 * @param discordId Discord snowflake of the user to look up.
 * @returns The user's normalized Twitch channel name (or null if unset/invalid) and Twitch-bot-enabled flag.
 * @throws If no user exists with the given `discordId`.
 */
export async function getUserTwitchEligibility(executor: SqlExecutor, discordId: string): Promise<UserTwitchEligibility> {
  const [userRows] = await executor.execute<mysql.RowDataPacket[]>(
    'SELECT twitch_name, is_twitch_bot_enabled FROM `user` WHERE discord_id = ? LIMIT 1',
    [discordId],
  );
  if (userRows.length === 0) {
    throw new Error(`User not found: ${discordId}`);
  }

  const twitchName = userRows[0].twitch_name ? String(userRows[0].twitch_name) : null;
  return {
    normalizedTwitchName: twitchName ? normalizeTwitchChannelName(twitchName) : null,
    isTwitchBotEnabled: fromBit(userRows[0].is_twitch_bot_enabled),
  };
}

/**
 * Checks whether `triggerString` is already used by another command that is either
 * multi-Twitch or assigned to a user with the same normalized Twitch channel name.
 * @param executor Pool or transaction connection to query with.
 * @param commandId Command id to exclude from the conflict check.
 * @param triggerString Trigger string to check for conflicts.
 * @param normalizedTwitchName Normalized (lowercased) Twitch channel name to match against.
 * @returns True if a conflicting command exists.
 */
async function hasTwitchChannelTriggerConflict(
  executor: SqlExecutor,
  commandId: number,
  triggerString: string,
  normalizedTwitchName: string,
): Promise<boolean> {
  const [conflictRows] = await executor.execute<mysql.RowDataPacket[]>(
    `SELECT c.command_id
     FROM custom_command c
     LEFT JOIN twitch_user_commands tuc ON tuc.command_id = c.command_id
     LEFT JOIN \`user\` u ON u.discord_id = tuc.discord_id
     WHERE c.command_id <> ?
       AND c.trigger_string = ?
       AND (
         c.is_multi_twitch = 1
         OR (
           u.twitch_name IS NOT NULL
           AND u.is_twitch_bot_enabled = 1
           AND LOWER(u.twitch_name) = ?
         )
       )
     LIMIT 1`,
    [commandId, triggerString, normalizedTwitchName],
  );

  return conflictRows.length > 0;
}

/**
 * Throws if `triggerString` is already used by another command that is either
 * multi-Twitch or assigned to a user with the same normalized Twitch channel name.
 * @param executor Pool or transaction connection to query with.
 * @param commandId Command id to exclude from the conflict check.
 * @param triggerString Trigger string to check for conflicts.
 * @param normalizedTwitchName Normalized (lowercased) Twitch channel name to match against.
 * @throws {CommandConflictError} If a conflicting command exists.
 */
export async function assertNoTwitchChannelTriggerConflict(
  executor: SqlExecutor,
  commandId: number,
  triggerString: string,
  normalizedTwitchName: string,
): Promise<void> {
  if (await hasTwitchChannelTriggerConflict(executor, commandId, triggerString, normalizedTwitchName)) {
    throw new CommandConflictError([triggerString]);
  }
}

/**
 * Inserts (or no-ops if already present) an assignment linking a Discord user to a custom command
 * for single-Twitch triggering.
 * @param executor Pool or transaction connection to query with.
 * @param commandId Command id being assigned.
 * @param discordId Discord snowflake of the user being assigned.
 */
export async function insertUserCommandAssignment(
  executor: SqlExecutor,
  commandId: number,
  discordId: string,
): Promise<void> {
  await executor.execute(
    `INSERT INTO twitch_user_commands (command_id, discord_id)
     VALUES (?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       command_id = new_row.command_id`,
    [commandId, discordId],
  );
}

/**
 * Assigns a Discord user to a custom command for single-Twitch triggering, running the conflict
 * check and insert inside a transaction guarded by a named lock on the command's trigger string.
 * Retries on deadlock up to `MAX_DEADLOCK_RETRIES` times, re-acquiring the transaction each attempt
 * while holding the same session-scoped lock across attempts.
 * @param connection Transaction-capable pool connection to run the work on.
 * @param commandId Command id being assigned.
 * @param discordId Discord snowflake of the user being assigned.
 * @throws {CommandConflictError} If the assignment would create a Twitch-channel trigger conflict.
 * @throws If the deadlock retry limit is reached.
 */
export async function assignUserToCommandWithinTransaction(
  connection: mysql.PoolConnection,
  commandId: number,
  discordId: string,
): Promise<void> {
  // The named lock is session-scoped: acquire it once and release it in the outer finally,
  // so deadlock retries on the inner transaction still hold the lock between attempts.
  let lockNameByTrigger: string | null = null;

  try {
    for (let attempt = 0; attempt < MAX_DEADLOCK_RETRIES; attempt++) {
      await connection.beginTransaction();
      try {
        const normalizedTriggerString = await getCommandTriggerStringById(connection, commandId);

        if (!lockNameByTrigger) {
          lockNameByTrigger = getCommandWriteLockName(normalizedTriggerString);
          await acquireNamedLock(connection, lockNameByTrigger);
        }

        const userEligibility = await getUserTwitchEligibility(connection, discordId);
        if (userEligibility.normalizedTwitchName && userEligibility.isTwitchBotEnabled) {
          await assertNoTwitchChannelTriggerConflict(
            connection,
            commandId,
            normalizedTriggerString,
            userEligibility.normalizedTwitchName,
          );
        }

        await insertUserCommandAssignment(connection, commandId, discordId);
        await connection.commit();
        return;
      } catch (error) {
        await connection.rollback();
        if (isDeadlockError(error) && attempt < MAX_DEADLOCK_RETRIES - 1) {
          log.warn(`Deadlock in assignUserToCommand, retrying (attempt ${attempt + 1}/${MAX_DEADLOCK_RETRIES}).`);
          continue;
        }
        throw error;
      }
    }

    throw new Error('[DB] Deadlock retry limit reached in assignUserToCommandWithinTransaction.');
  } finally {
    if (lockNameByTrigger) {
      try { await releaseNamedLock(connection, lockNameByTrigger); } catch (err) { log.warn('Failed to release named lock:', err); }
    }
  }
}
