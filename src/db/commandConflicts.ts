import mysql from 'mysql2/promise';
import { normalizeTwitchChannelName } from '../twitchChannelName';
import { type SqlExecutor, CommandConflictError } from './commandStringUtils';
import {
  acquireNamedLock,
  releaseNamedLock,
  getCommandWriteLockName,
  isDeadlockError,
  MAX_DEADLOCK_RETRIES,
} from './commandLocks';

// ─── Conflict assertions ──────────────────────────────────────────────────────

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

export async function assertMultiTwitchTriggerAvailable(
  executor: SqlExecutor,
  triggerString: string,
  excludeCommandId?: number,
): Promise<void> {
  if (await hasMultiTwitchTriggerConflict(executor, triggerString, excludeCommandId)) {
    throw new CommandConflictError([triggerString]);
  }
}

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

export async function assertNoSingleTwitchAssignmentOverlap(
  executor: SqlExecutor,
  commandId: number,
  triggerString: string,
): Promise<void> {
  if (await hasSingleTwitchAssignmentOverlap(executor, commandId, triggerString)) {
    throw new CommandConflictError([triggerString]);
  }
}

export async function getCommandTriggerStringById(executor: SqlExecutor, commandId: number): Promise<string> {
  const [commandRows] = await executor.execute<mysql.RowDataPacket[]>(
    'SELECT trigger_string FROM custom_command WHERE command_id = ? LIMIT 1',
    [commandId],
  );
  if (commandRows.length === 0) {
    throw new Error(`Custom command not found: ${commandId}`);
  }

  return String(commandRows[0].trigger_string).trim().toLowerCase();
}

interface UserTwitchEligibility {
  normalizedTwitchName: string | null;
  isTwitchBotEnabled: boolean;
}

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
    isTwitchBotEnabled: Buffer.isBuffer(userRows[0].is_twitch_bot_enabled)
      ? userRows[0].is_twitch_bot_enabled[0] === 1
      : userRows[0].is_twitch_bot_enabled == 1,
  };
}

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

export async function insertUserCommandAssignment(
  executor: SqlExecutor,
  commandId: number,
  discordId: string,
): Promise<void> {
  await executor.execute(
    `INSERT INTO twitch_user_commands (command_id, discord_id)
     VALUES (?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       command_id = command_id`,
    [commandId, discordId],
  );
}

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
          console.warn(`[DB] Deadlock in assignUserToCommand, retrying (attempt ${attempt + 1}/${MAX_DEADLOCK_RETRIES}).`);
          continue;
        }
        throw error;
      }
    }

    throw new Error('[DB] Deadlock retry limit reached in assignUserToCommandWithinTransaction.');
  } finally {
    if (lockNameByTrigger) {
      await releaseNamedLock(connection, lockNameByTrigger);
    }
  }
}
