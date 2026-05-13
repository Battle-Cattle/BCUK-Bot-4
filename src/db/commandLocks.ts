import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { normalizeTwitchChannelName } from '../twitchChannelName';
import { getPool } from './pool';

export type SqlExecutor = mysql.Pool | mysql.PoolConnection;

const COMMAND_WRITE_LOCK_TIMEOUT_SECONDS = 10;

// ─── String normalisation ────────────────────────────────────────────────────

export function requireTrimmedString(value: string, fieldName: string): string {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    throw new Error(`Missing ${fieldName}`);
  }
  return normalizedValue;
}

function normalizeCommand(command: string): string | null {
  const normalized = command.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeCommandList(commandOrCommands: string | string[]): string[] {
  const commands = Array.isArray(commandOrCommands) ? commandOrCommands : [commandOrCommands];
  return commands
    .map((command) => normalizeCommand(command))
    .filter((command): command is string => command !== null);
}

export function normalizeCommandInputs(commandOrCommands: string | string[]): string[] {
  return Array.from(new Set(normalizeCommandList(commandOrCommands)));
}

export function buildInClausePlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

// ─── Named locks ─────────────────────────────────────────────────────────────

export function getCommandWriteLockName(command: string): string {
  return `bcuk_cmd_${createHash('sha256').update(command).digest('hex').slice(0, 48)}`;
}

function getSortedCommandLockNames(commands: string[]): string[] {
  return commands
    .slice()
    .sort((left, right) => {
      if (left === right) return 0;
      return left < right ? -1 : 1;
    })
    .map((command) => getCommandWriteLockName(command));
}

export async function acquireNamedLock(connection: mysql.PoolConnection, lockName: string): Promise<void> {
  const [rows] = await connection.execute<mysql.RowDataPacket[]>(
    'SELECT GET_LOCK(?, ?) AS lock_status',
    [lockName, COMMAND_WRITE_LOCK_TIMEOUT_SECONDS],
  );

  // GET_LOCK returns a BIGINT. With bigNumberStrings: true, it's the string "1", not number 1.
  const lockStatus = rows[0]?.lock_status;
  if (lockStatus === '1' || lockStatus === 1) return;

  const message = (lockStatus === '0' || lockStatus === 0)
    ? `Timed out acquiring command write lock '${lockName}'`
    : lockStatus == null
      ? `Internal error acquiring command write lock '${lockName}'`
      : `Unexpected result acquiring command write lock '${lockName}'`;

  throw new Error(`${message} (lock_status=${String(lockStatus)}).`);
}

export async function releaseNamedLock(connection: mysql.PoolConnection, lockName: string): Promise<void> {
  try {
    await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
  } catch (error) {
    console.warn(`[DB] Failed to release command write lock '${lockName}':`, error);
  }
}

async function acquireNamedLocks(connection: mysql.PoolConnection, lockNames: string[]): Promise<void> {
  for (const lockName of lockNames) {
    await acquireNamedLock(connection, lockName);
  }
}

async function releaseNamedLocks(connection: mysql.PoolConnection, lockNames: string[]): Promise<void> {
  for (let index = lockNames.length - 1; index >= 0; index -= 1) {
    await releaseNamedLock(connection, lockNames[index]);
  }
}

// ─── Error types ─────────────────────────────────────────────────────────────

export class CommandNotFoundError extends Error {
  constructor(id: number) {
    super(`Command not found: ${id}`);
    this.name = 'CommandNotFoundError';
  }
}

export class CommandConflictError extends Error {
  readonly commands: string[];

  constructor(commands: string[]) {
    super(`Command already taken: ${commands.join(', ')}`);
    this.name = 'CommandConflictError';
    this.commands = commands;
  }
}

export function isMysqlDuplicateEntryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const mysqlError = error as { code?: string; errno?: number };
  return mysqlError.code === 'ER_DUP_ENTRY' || mysqlError.errno === 1062;
}

// ─── Exists checks ────────────────────────────────────────────────────────────

interface SqlExistsCheckPlan {
  sql: string;
  params: Array<string | number>;
}

function buildCustomCommandExistsCheckPlan(
  placeholders: string,
  normalizedCommands: string[],
  options?: { excludeCustomCommandId?: number; excludeCounterId?: number },
): SqlExistsCheckPlan {
  let sql = `SELECT 1 FROM custom_command WHERE trigger_string IN (${placeholders})`;
  const params: Array<string | number> = [...normalizedCommands];

  if (options?.excludeCustomCommandId !== undefined) {
    sql += ' AND command_id != ?';
    params.push(options.excludeCustomCommandId);
  }

  sql += ' LIMIT 1';
  return { sql, params };
}

function buildCounterExistsCheckPlan(
  placeholders: string,
  normalizedCommands: string[],
  options?: { excludeCustomCommandId?: number; excludeCounterId?: number },
): SqlExistsCheckPlan {
  let sql = `SELECT 1 FROM counter WHERE (trigger_command IN (${placeholders}) OR check_command IN (${placeholders}))`;
  const params: Array<string | number> = [...normalizedCommands, ...normalizedCommands];

  if (options?.excludeCounterId !== undefined) {
    sql += ' AND id != ?';
    params.push(options.excludeCounterId);
  }

  sql += ' LIMIT 1';
  return { sql, params };
}

async function executeExistsCheck(executor: SqlExecutor, plan: SqlExistsCheckPlan): Promise<boolean> {
  const [rows] = await executor.execute<mysql.RowDataPacket[]>(plan.sql, plan.params);
  return rows.length > 0;
}

export async function isAnyCommandTakenAcrossTables(
  commandOrCommands: string | string[],
  options?: { excludeCustomCommandId?: number; excludeCounterId?: number },
  executor: SqlExecutor = getPool(),
  checks: { includeCustomCommandTable?: boolean; includeCounterTable?: boolean } = {
    includeCustomCommandTable: true,
    includeCounterTable: true,
  },
): Promise<boolean> {
  const normalizedCommands = normalizeCommandInputs(commandOrCommands);
  if (normalizedCommands.length === 0) {
    return false;
  }

  const placeholders = buildInClausePlaceholders(normalizedCommands.length);
  const existsChecks: Promise<boolean>[] = [];

  if (checks.includeCustomCommandTable !== false) {
    existsChecks.push(executeExistsCheck(executor, buildCustomCommandExistsCheckPlan(placeholders, normalizedCommands, options)));
  }

  if (checks.includeCounterTable !== false) {
    existsChecks.push(executeExistsCheck(executor, buildCounterExistsCheckPlan(placeholders, normalizedCommands, options)));
  }

  const results = await Promise.all(existsChecks);
  return results.some((exists) => exists);
}

export async function isCustomCommandTriggerTaken(triggerString: string, excludeCommandId?: number): Promise<boolean> {
  return isAnyCommandTakenAcrossTables(triggerString, { excludeCustomCommandId: excludeCommandId });
}

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
  await connection.beginTransaction();
  let lockNameByTrigger: string | null = null;

  try {
    // Re-read the current trigger_string inside the transaction.
    // This read comes from the transaction snapshot. If another transaction updates
    // the same command's trigger in a tiny concurrent window, the conflict check
    // below can be conservative until the next cache rebuild.
    const normalizedTriggerString = await getCommandTriggerStringById(connection, commandId);
    lockNameByTrigger = getCommandWriteLockName(normalizedTriggerString);

    // Named locks are session-scoped (not transaction-scoped), so this must be released explicitly.
    await acquireNamedLock(connection, lockNameByTrigger);

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
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    if (lockNameByTrigger) {
      await releaseNamedLock(connection, lockNameByTrigger);
    }
  }
}

export async function commandExists(id: number, executor: SqlExecutor = getPool()): Promise<boolean> {
  const [rows] = await executor.execute<mysql.RowDataPacket[]>(
    'SELECT 1 FROM custom_command WHERE command_id = ? LIMIT 1',
    [id],
  );
  return rows.length > 0;
}

export async function runSerializedCommandWrite<T>(
  commandOrCommands: string | string[],
  options: { excludeCustomCommandId?: number; excludeCounterId?: number } | undefined,
  writeOperation: (connection: mysql.PoolConnection) => Promise<T>,
  checks: { includeCustomCommandTable?: boolean; includeCounterTable?: boolean } = {
    includeCustomCommandTable: true,
    includeCounterTable: true,
  },
): Promise<T> {
  const normalizedCommands = normalizeCommandInputs(commandOrCommands);
  const lockNames = getSortedCommandLockNames(normalizedCommands);
  let connection: mysql.PoolConnection | null = null;

  try {
    connection = await getPool().getConnection();
    await acquireNamedLocks(connection, lockNames);

    await connection.beginTransaction();

    try {
      if (await isAnyCommandTakenAcrossTables(normalizedCommands, options, connection, checks)) {
        throw new CommandConflictError(normalizedCommands);
      }

      const result = await writeOperation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    if (connection) {
      try { await releaseNamedLocks(connection, lockNames); } catch (_) {}
      connection.release();
    }
  }
}
