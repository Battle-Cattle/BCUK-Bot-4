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
  CommandNotFoundError,
  CommandConflictError,
  isMysqlDuplicateEntryError,
} from './commandStringUtils';

const COMMAND_WRITE_LOCK_TIMEOUT_SECONDS = 10;

// ─── Deadlock retry ──────────────────────────────────────────────────────────

export const MAX_DEADLOCK_RETRIES = 3;

/** Returns true if `error` is a MySQL deadlock error (`ER_LOCK_DEADLOCK` / errno 1213). */
export function isDeadlockError(error: unknown): boolean {
  const err = error as { code?: string; errno?: number };
  return err.code === 'ER_LOCK_DEADLOCK' || err.errno === 1213;
}

// ─── Named locks ─────────────────────────────────────────────────────────────

/** Derives a stable, length-bounded MySQL named-lock name for a command string, via a truncated SHA-256 hash. */
export function getCommandWriteLockName(command: string): string {
  return `bcuk_cmd_${createHash('sha256').update(command).digest('hex').slice(0, 48)}`;
}

/** Maps `commands` to their lock names, sorted so callers always acquire multiple locks in a consistent order (avoids lock-order deadlocks). */
function getSortedCommandLockNames(commands: string[]): string[] {
  return commands
    .slice()
    .sort((left, right) => {
      if (left === right) return 0;
      return left < right ? -1 : 1;
    })
    .map((command) => getCommandWriteLockName(command));
}

/**
 * Acquires a MySQL `GET_LOCK` named lock on `connection`, waiting up to
 * `COMMAND_WRITE_LOCK_TIMEOUT_SECONDS`.
 * @param connection - Pool connection to run `GET_LOCK` on.
 * @param lockName - Name of the lock to acquire (see {@link getCommandWriteLockName}).
 * @returns Resolves once the lock is held.
 * @throws If `GET_LOCK` times out (result `0`), returns null (an internal MySQL error), or
 *   returns any other unexpected value.
 */
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

/** Releases a MySQL named lock on `connection`. Swallows and logs any error — releasing must never block the caller's cleanup. */
export async function releaseNamedLock(connection: mysql.PoolConnection, lockName: string): Promise<void> {
  try {
    await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
  } catch (error) {
    log.warn(`Failed to release command write lock '${lockName}':`, error);
  }
}

/**
 * Acquires each of `lockNames` in order (see {@link getSortedCommandLockNames} for why order matters).
 * @param connection - Pool connection to acquire the locks on.
 * @param lockNames - Lock names to acquire, in acquisition order.
 * @returns Resolves once every lock in `lockNames` is held.
 */
async function acquireNamedLocks(connection: mysql.PoolConnection, lockNames: string[]): Promise<void> {
  for (const lockName of lockNames) {
    await acquireNamedLock(connection, lockName);
  }
}

/**
 * Releases `lockNames` in reverse-acquisition order.
 * @param connection - Pool connection the locks were acquired on.
 * @param lockNames - Lock names to release, in the same order they were acquired.
 * @returns Resolves once every release attempt has completed.
 */
async function releaseNamedLocks(connection: mysql.PoolConnection, lockNames: string[]): Promise<void> {
  for (let index = lockNames.length - 1; index >= 0; index -= 1) {
    await releaseNamedLock(connection, lockNames[index]);
  }
}

/**
 * Runs `body` inside a transaction on `connection`, for up to {@link MAX_DEADLOCK_RETRIES}
 * attempts: begins a transaction, runs `body`, and commits on success. On error, rolls back;
 * if the error is a deadlock and this wasn't the final attempt, logs and retries; otherwise
 * rethrows the original error, unless `exhaustedErrorMessage` is given, in which case a
 * deadlock on the final attempt throws a new `Error(exhaustedErrorMessage)` instead of the raw
 * driver error (a non-deadlock error always rethrows as-is, on any attempt). Factors out the
 * retry/transaction scaffolding shared by {@link runSerializedCommandWrite} (in `commandLocks.ts`)
 * and `withDeadlockRetryAndTriggerLock` (in `commandConflicts.ts`), which differ only in how
 * their named lock(s) are acquired around this loop.
 * @param connection Transaction-capable pool connection to run `body` on.
 * @param retryLogLabel Short label for the deadlock-retry log message.
 * @param body Per-attempt work to run inside the transaction, given the 0-based attempt index.
 *   Must not itself begin/commit/rollback a transaction.
 * @param exhaustedErrorMessage When given, thrown instead of the raw deadlock error if a
 *   deadlock persists through every attempt.
 * @returns The value returned by `body` on the attempt that commits successfully.
 * @throws Whatever `body` throws, when not a deadlock (or once retries are exhausted and
 *   `exhaustedErrorMessage` isn't given); {@link Error}(`exhaustedErrorMessage`) if retries
 *   are exhausted and it is given.
 */
export async function runWithDeadlockRetry<T>(
  connection: mysql.PoolConnection,
  retryLogLabel: string,
  body: (attempt: number) => Promise<T>,
  exhaustedErrorMessage?: string,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_DEADLOCK_RETRIES; attempt++) {
    await connection.beginTransaction();
    try {
      const result = await body(attempt);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      const deadlock = isDeadlockError(error);
      if (deadlock && attempt < MAX_DEADLOCK_RETRIES - 1) {
        log.warn(`Deadlock in ${retryLogLabel}, retrying (attempt ${attempt + 1}/${MAX_DEADLOCK_RETRIES}).`);
        continue;
      }
      if (deadlock && exhaustedErrorMessage !== undefined) {
        throw new Error(exhaustedErrorMessage, { cause: error });
      }
      throw error;
    }
  }
  throw new Error(`[DB] Deadlock retry limit reached in ${retryLogLabel}.`);
}

// ─── Exists checks ────────────────────────────────────────────────────────────

interface SqlExistsCheckPlan {
  sql: string;
  params: Array<string | number>;
}

/**
 * Builds the SQL + params for checking whether `normalizedCommands` collide with an existing `custom_command` row.
 * @param placeholders - `IN (...)` placeholder string sized for `normalizedCommands.length`.
 * @param normalizedCommands - Normalized command strings to check for a collision.
 * @param options.excludeCustomCommandId - A `command_id` to exclude from the check.
 * @returns The SQL and params to run via {@link executeExistsCheck}.
 */
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

/**
 * Builds the SQL + params for checking whether `normalizedCommands` collide with an existing `counter` row's trigger/check command.
 * @param placeholders - `IN (...)` placeholder string sized for `normalizedCommands.length`.
 * @param normalizedCommands - Normalized command strings to check for a collision.
 * @param options.excludeCounterId - A counter `id` to exclude from the check.
 * @returns The SQL and params to run via {@link executeExistsCheck}.
 */
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

/**
 * Runs an exists-check plan built by {@link buildCustomCommandExistsCheckPlan}/{@link buildCounterExistsCheckPlan} and reports whether any row matched.
 * @param executor - Query executor to run the plan on.
 * @param plan - The SQL and params to execute.
 * @returns True if the query matched at least one row.
 */
async function executeExistsCheck(executor: SqlExecutor, plan: SqlExistsCheckPlan): Promise<boolean> {
  const [rows] = await executor.execute<mysql.RowDataPacket[]>(plan.sql, plan.params);
  return rows.length > 0;
}

/**
 * Checks whether any of `commandOrCommands` is already taken by a `custom_command` or
 * `counter` row (whichever tables `checks` enables), optionally excluding a specific
 * command/counter id from the check (used when updating an existing row in place).
 * @param commandOrCommands - A single command string or array of command strings to check.
 * @param options - Ids to exclude from the collision check, if updating an existing row.
 * @param executor - Query executor to run the checks on; defaults to the pool, but a
 *   transaction connection is passed when called from {@link runSerializedCommandWrite}.
 * @param checks - Which tables to check; both default to enabled.
 * @returns True if any command in `commandOrCommands` is already taken.
 */
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

/**
 * Checks whether `triggerString` is already taken by a custom command or counter, optionally excluding `excludeCommandId` from the check.
 * @param triggerString - Trigger string to check for a collision.
 * @param excludeCommandId - A `command_id` to exclude from the check, if updating an existing row.
 * @returns True if `triggerString` is already taken.
 */
export async function isCustomCommandTriggerTaken(triggerString: string, excludeCommandId?: number): Promise<boolean> {
  return isAnyCommandTakenAcrossTables(triggerString, { excludeCustomCommandId: excludeCommandId });
}

// ─── Serialized write ─────────────────────────────────────────────────────────

/**
 * Checks whether a `custom_command` row with the given `id` exists.
 * @param id - The `command_id` to look up.
 * @param executor - Query executor to run the check on; defaults to the pool.
 * @returns True if a row with that `id` exists.
 */
export async function commandExists(id: number, executor: SqlExecutor = getPool()): Promise<boolean> {
  return rowExists(executor, 'custom_command', 'command_id', id);
}

/**
 * Runs `writeOperation` inside a transaction, serialized against other writers of the same
 * command(s) via MySQL named locks, with a fresh trigger-collision check and automatic
 * retry on deadlock.
 *
 * Acquires a named lock per command in `commandOrCommands` (sorted, to avoid lock-order
 * deadlocks across concurrent multi-command writes), then — for up to
 * {@link MAX_DEADLOCK_RETRIES} attempts — opens a transaction, re-checks for a trigger
 * collision against whichever tables `checks` enables (guarding against a race between the
 * caller's earlier check and now), runs `writeOperation`, and commits. A `ER_LOCK_DEADLOCK`
 * during a non-final attempt rolls back and retries; any other error (including a collision,
 * which throws {@link CommandConflictError}) rolls back and propagates immediately. Lock
 * release is attempted and the connection returned to the pool in a `finally`; a release
 * failure is logged and swallowed rather than masking the original error.
 * @param commandOrCommands - The command(s) this write claims; also used for the collision check.
 * @param options - Ids to exclude from the collision check, if updating an existing row.
 * @param writeOperation - The transactional write to perform once locks are held and no collision exists.
 * @param checks - Which tables to include in the collision check; both default to enabled.
 * @returns The value returned by `writeOperation`.
 * @throws {@link CommandConflictError} if a collision is detected.
 */
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
    const conn = connection;
    await acquireNamedLocks(conn, lockNames);

    return await runWithDeadlockRetry(conn, 'runSerializedCommandWrite', async () => {
      if (await isAnyCommandTakenAcrossTables(normalizedCommands, options, conn, checks)) {
        throw new CommandConflictError(normalizedCommands);
      }
      return await writeOperation(conn);
    });
  } finally {
    if (connection) {
      try { await releaseNamedLocks(connection, lockNames); } catch (err) { log.warn('Failed to release named locks:', err); }
      connection.release();
    }
  }
}
