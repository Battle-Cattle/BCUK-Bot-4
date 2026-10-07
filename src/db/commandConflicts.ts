// Trigger-conflict assertions for custom commands: Discord, multi-Twitch and per-channel Twitch
// collisions. Read-only checks; the writes that call them live in `customCommands.ts` and
// `commandAssignments.ts`.
import mysql from 'mysql2/promise';
import { CommandConflictError } from './commandErrors';
import { buildInClausePlaceholders, type SqlExecutor } from './utils';

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
 * Checks whether `triggerString` is already used by another command that is either
 * multi-Twitch or assigned to a user whose normalized Twitch channel name is in
 * `normalizedTwitchNames`. Backs {@link assertNoTwitchChannelTriggerConflict}, which the
 * single-user assignment path calls with a one-element array and the batched multi-user path
 * (`assertAllUsersAssignable` in `commandAssignments.ts`) with every eligible user's name.
 * @param executor Pool or transaction connection to query with.
 * @param commandId Command id to exclude from the conflict check.
 * @param triggerString Trigger string to check for conflicts.
 * @param normalizedTwitchNames Normalized (lowercased) Twitch channel names to match against.
 *   Must be non-empty.
 * @returns True if a conflicting command exists for any of the given names.
 */
async function hasTriggerConflictForTwitchNames(
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
 * Throws if `triggerString` is already used by another command that is either multi-Twitch or
 * assigned to a user whose normalized Twitch channel name is in `normalizedTwitchNames` — one
 * batched query however many names are checked (see {@link hasTriggerConflictForTwitchNames}).
 * @param executor Pool or transaction connection to query with.
 * @param commandId Command id to exclude from the conflict check.
 * @param triggerString Trigger string to check for conflicts.
 * @param normalizedTwitchNames Normalized (lowercased) Twitch channel names to match against.
 *   Must be non-empty.
 * @throws {CommandConflictError} If a conflicting command exists.
 */
export async function assertNoTwitchChannelTriggerConflict(
  executor: SqlExecutor,
  commandId: number,
  triggerString: string,
  normalizedTwitchNames: string[],
): Promise<void> {
  await assertConflictFree(triggerString, () =>
    hasTriggerConflictForTwitchNames(executor, commandId, triggerString, normalizedTwitchNames));
}
