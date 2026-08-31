import { createLogger } from '../shared/logger';
import mysql from 'mysql2/promise';

const log = createLogger('DB');
import { normalizeTwitchChannelName } from '../twitch/twitchChannelName';
import { type SqlExecutor, CommandConflictError, normalizeCommand, buildInClausePlaceholders } from './commandStringUtils';
import {
  acquireNamedLock,
  releaseNamedLock,
  getCommandWriteLockName,
  runWithDeadlockRetry,
} from './commandLocks';
import { fromBit } from './utils';

// ─── Conflict assertions ──────────────────────────────────────────────────────

/**
 * Throws a {@link CommandConflictError} for `triggerString` if `checkFn` reports a conflict.
 * Factors out the repeated "run a conflict check, throw if true" shape shared by
 * {@link assertMultiTwitchTriggerAvailable}, {@link assertNoSingleTwitchAssignmentOverlap},
 * and {@link assertNoTwitchChannelTriggerConflict}.
 * @param triggerString Trigger string to include in the thrown error.
 * @param checkFn Callback that resolves true if a conflicting command exists.
 * @throws {CommandConflictError} If `checkFn` resolves true.
 */
async function assertConflictFree(triggerString: string, checkFn: () => Promise<boolean>): Promise<void> {
  if (await checkFn()) {
    throw new CommandConflictError([triggerString]);
  }
}

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
  await assertConflictFree(triggerString, () => hasMultiTwitchTriggerConflict(executor, triggerString, excludeCommandId));
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
           AND other_u.twitch_name = current_u.twitch_name
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
  await assertConflictFree(triggerString, () => hasSingleTwitchAssignmentOverlap(executor, commandId, triggerString));
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

export interface UserTwitchEligibility {
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
 * Looks up multiple users' normalized Twitch channel names and Twitch-bot-enabled flags in one
 * query, used by the batch assignment path to avoid a per-user round trip.
 * @param executor Pool or transaction connection to query with.
 * @param discordIds Discord snowflakes of the users to look up.
 * @returns A map from `discordId` to its eligibility. `discordId`s with no matching user are omitted.
 */
export async function getUserTwitchEligibilityBatch(
  executor: SqlExecutor,
  discordIds: string[],
): Promise<Map<string, UserTwitchEligibility>> {
  const result = new Map<string, UserTwitchEligibility>();
  if (discordIds.length === 0) return result;

  const [userRows] = await executor.execute<mysql.RowDataPacket[]>(
    `SELECT discord_id, twitch_name, is_twitch_bot_enabled FROM \`user\` WHERE discord_id IN (${buildInClausePlaceholders(discordIds.length)})`,
    discordIds,
  );

  for (const row of userRows) {
    const twitchName = row.twitch_name ? String(row.twitch_name) : null;
    result.set(String(row.discord_id), {
      normalizedTwitchName: twitchName ? normalizeTwitchChannelName(twitchName) : null,
      isTwitchBotEnabled: fromBit(row.is_twitch_bot_enabled),
    });
  }

  return result;
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
           AND u.twitch_name = ?
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
  await assertConflictFree(triggerString, () => hasTwitchChannelTriggerConflict(executor, commandId, triggerString, normalizedTwitchName));
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
 * Runs `body` inside a transaction guarded by a named lock on `commandId`'s trigger string,
 * retrying on deadlock up to `MAX_DEADLOCK_RETRIES` times (via {@link runWithDeadlockRetry}).
 * The named lock is session-scoped: acquired once (on the first attempt, after the trigger
 * string is known) and released in the outer `finally`, so deadlock retries on the inner
 * transaction still hold the lock between attempts. Factors out the retry/lock/transaction
 * scaffolding shared by {@link assignUserToCommandWithinTransaction} and
 * {@link assignUsersToCommandWithinTransaction}, which differ only in the eligibility lookup,
 * conflict checks, and insert `body` performs.
 * @param connection Transaction-capable pool connection to run the work on.
 * @param commandId Command id whose trigger string the named lock is scoped to.
 * @param retryLogLabel Short name of the calling function, used in the deadlock-retry log message.
 * @param retryLimitFnName Full name of the calling function, used in the retry-limit-reached error message.
 * @param body Per-attempt work to run inside the transaction, given the command's normalized
 *   trigger string. Must not itself begin/commit/rollback a transaction.
 * @throws Whatever `body` throws (e.g. {@link CommandConflictError}), when that error isn't a deadlock.
 * @throws If a deadlock persists through all `MAX_DEADLOCK_RETRIES` attempts.
 */
async function withDeadlockRetryAndTriggerLock(
  connection: mysql.PoolConnection,
  commandId: number,
  retryLogLabel: string,
  retryLimitFnName: string,
  body: (normalizedTriggerString: string) => Promise<void>,
): Promise<void> {
  // The named lock is session-scoped: acquire it once and release it in the outer finally,
  // so deadlock retries on the inner transaction still hold the lock between attempts.
  let lockNameByTrigger: string | null = null;

  try {
    await runWithDeadlockRetry(
      connection,
      retryLogLabel,
      // Looks up the command's current trigger string, acquires the session-scoped named lock
      // on it if this is the first attempt to reach here, then runs the caller's `body`. Returns
      // nothing — `body` performs the actual write; a thrown error (e.g. a fresh
      // `CommandConflictError`) propagates up through `runWithDeadlockRetry`, which rolls back
      // and either retries (on deadlock) or rethrows.
      async () => {
        const normalizedTriggerString = await getCommandTriggerStringById(connection, commandId);

        if (!lockNameByTrigger) {
          lockNameByTrigger = getCommandWriteLockName(normalizedTriggerString);
          await acquireNamedLock(connection, lockNameByTrigger);
        }

        await body(normalizedTriggerString);
      },
      `[DB] Deadlock retry limit reached in ${retryLimitFnName}.`,
    );
  } finally {
    if (lockNameByTrigger) {
      try { await releaseNamedLock(connection, lockNameByTrigger); } catch (err) { log.warn('Failed to release named lock:', err); }
    }
  }
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
  await withDeadlockRetryAndTriggerLock(
    connection,
    commandId,
    'assignUserToCommand',
    'assignUserToCommandWithinTransaction',
    /**
     * Per-attempt body: checks the user's Twitch-channel trigger conflict (if eligible) and
     * inserts the assignment row.
     * @param normalizedTriggerString The command's normalized trigger string, looked up fresh each attempt.
     * @returns Resolves once the conflict check (if any) and insert both succeed.
     */
    async (normalizedTriggerString) => {
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
    },
  );
}

/**
 * Inserts (or no-ops if already present) assignments linking multiple Discord users to a custom
 * command for single-Twitch triggering, in one multi-row upsert.
 * @param executor Pool or transaction connection to query with.
 * @param commandId Command id being assigned.
 * @param discordIds Discord snowflakes of the users being assigned.
 */
export async function insertUserCommandAssignments(
  executor: SqlExecutor,
  commandId: number,
  discordIds: string[],
): Promise<void> {
  if (discordIds.length === 0) return;

  const placeholders = discordIds.map(() => '(?, ?)').join(', ');
  const params = discordIds.flatMap((discordId) => [commandId, discordId]);
  await executor.execute(
    `INSERT INTO twitch_user_commands (command_id, discord_id)
     VALUES ${placeholders} AS new_row
     ON DUPLICATE KEY UPDATE
       command_id = new_row.command_id`,
    params,
  );
}

/**
 * Batched form of {@link hasTwitchChannelTriggerConflict}: checks whether `triggerString` is
 * already used by another command that is either multi-Twitch or assigned to a user whose
 * normalized Twitch channel name is in `normalizedTwitchNames` — one query covering every
 * eligible user in a bulk assignment, instead of one query per user.
 * @param executor Pool or transaction connection to query with.
 * @param commandId Command id to exclude from the conflict check.
 * @param triggerString Trigger string to check for conflicts.
 * @param normalizedTwitchNames Normalized (lowercased) Twitch channel names to match against.
 *   Must be non-empty.
 * @returns True if a conflicting command exists for any of the given names.
 */
async function hasAnyTwitchChannelTriggerConflict(
  executor: SqlExecutor,
  commandId: number,
  triggerString: string,
  normalizedTwitchNames: string[],
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
           AND u.twitch_name IN (${buildInClausePlaceholders(normalizedTwitchNames.length)})
         )
       )
     LIMIT 1`,
    [commandId, triggerString, ...normalizedTwitchNames],
  );

  return conflictRows.length > 0;
}

/**
 * Throws if any `discordId` has no matching eligibility entry, or if any Twitch-eligible user's
 * channel would create a trigger conflict — checked in a single batched query across every
 * eligible user (see {@link hasAnyTwitchChannelTriggerConflict}) rather than one query per user.
 * @param connection Transaction-capable pool connection to query with.
 * @param commandId Command id being assigned.
 * @param discordIds Discord snowflakes of the users being checked.
 * @param normalizedTriggerString Normalized trigger string being assigned.
 * @param eligibilityByDiscordId Batch-fetched eligibility, keyed by `discordId`.
 * @throws {CommandConflictError} If any eligible user's Twitch channel would create a trigger conflict.
 * @throws If any `discordId` has no matching entry in `eligibilityByDiscordId`.
 */
async function assertAllUsersAssignable(
  connection: mysql.PoolConnection,
  commandId: number,
  discordIds: string[],
  normalizedTriggerString: string,
  eligibilityByDiscordId: Map<string, UserTwitchEligibility>,
): Promise<void> {
  const eligibleNames: string[] = [];
  for (const discordId of discordIds) {
    const eligibility = eligibilityByDiscordId.get(discordId);
    if (!eligibility) {
      throw new Error(`User not found: ${discordId}`);
    }
    if (eligibility.normalizedTwitchName && eligibility.isTwitchBotEnabled) {
      eligibleNames.push(eligibility.normalizedTwitchName);
    }
  }

  if (eligibleNames.length === 0) return;

  await assertConflictFree(normalizedTriggerString, () =>
    hasAnyTwitchChannelTriggerConflict(connection, commandId, normalizedTriggerString, eligibleNames));
}

/**
 * Assigns multiple Discord users to a custom command for single-Twitch triggering in a single
 * transaction guarded by a named lock on the command's trigger string, mirroring
 * {@link assignUserToCommandWithinTransaction} but batching the eligibility lookup, conflict
 * checks, and insert across all users instead of paying a lock/transaction/round-trip per user.
 * Retries on deadlock up to `MAX_DEADLOCK_RETRIES` times, re-acquiring the transaction each attempt
 * while holding the same session-scoped lock across attempts.
 * @param connection Transaction-capable pool connection to run the work on.
 * @param commandId Command id being assigned.
 * @param discordIds Discord snowflakes of the users being assigned.
 * @throws {CommandConflictError} If any assignment would create a Twitch-channel trigger conflict.
 * @throws If a `discordId` has no matching user, or the deadlock retry limit is reached.
 */
export async function assignUsersToCommandWithinTransaction(
  connection: mysql.PoolConnection,
  commandId: number,
  discordIds: string[],
): Promise<void> {
  if (discordIds.length === 0) return;

  await withDeadlockRetryAndTriggerLock(
    connection,
    commandId,
    'assignUsersToCommand',
    'assignUsersToCommandWithinTransaction',
    /**
     * Per-attempt body: batch-checks every user's Twitch-channel trigger conflict and inserts
     * all assignment rows in one upsert.
     * @param normalizedTriggerString The command's normalized trigger string, looked up fresh each attempt.
     * @returns Resolves once all conflict checks and the batch insert succeed.
     */
    async (normalizedTriggerString) => {
      const eligibilityByDiscordId = await getUserTwitchEligibilityBatch(connection, discordIds);
      await assertAllUsersAssignable(connection, commandId, discordIds, normalizedTriggerString, eligibilityByDiscordId);
      await insertUserCommandAssignments(connection, commandId, discordIds);
    },
  );
}
