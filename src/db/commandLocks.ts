import { createLogger } from '../shared/logger';
import { createHash } from 'node:crypto';

const log = createLogger('DB');
import mysql from 'mysql2/promise';
import { getPool } from './pool';
import {
  type SqlExecutor,
  CommandConflictError,
  normalizeCommandInputs,
  buildInClausePlaceholders,
} from './commandStringUtils';
import { rowExists } from './utils';

export type { SqlExecutor } from './commandStringUtils';
export {
  requireTrimmedString,
  normalizeCommandList,
  normalizeCommandInputs,
  buildInClausePlaceholders,
  CommandNotFoundError,
  CommandConflictError,
  isMysqlDuplicateEntryError,
} from './commandStringUtils';

const COMMAND_WRITE_LOCK_TIMEOUT_SECONDS = 10;

// ─── Deadlock retry ──────────────────────────────────────────────────────────

export const MAX_DEADLOCK_RETRIES = 3;

export function isDeadlockError(error: unknown): boolean {
  const err = error as { code?: string; errno?: number };
  return err.code === 'ER_LOCK_DEADLOCK' || err.errno === 1213;
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
    log.warn(`Failed to release command write lock '${lockName}':`, error);
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

// ─── Serialized write ─────────────────────────────────────────────────────────

export async function commandExists(id: number, executor: SqlExecutor = getPool()): Promise<boolean> {
  return rowExists(executor, 'custom_command', 'command_id', id);
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

    for (let attempt = 0; attempt < MAX_DEADLOCK_RETRIES; attempt++) {
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
        if (isDeadlockError(error) && attempt < MAX_DEADLOCK_RETRIES - 1) {
          log.warn(`Deadlock detected, retrying transaction (attempt ${attempt + 1}/${MAX_DEADLOCK_RETRIES}).`);
          continue;
        }
        throw error;
      }
    }

    throw new Error('[DB] Deadlock retry limit reached without success.');
  } finally {
    if (connection) {
      try { await releaseNamedLocks(connection, lockNames); } catch (err) { log.warn('Failed to release named locks:', err); }
      connection.release();
    }
  }
}
