// Cross-table trigger-collision checks (custom commands vs counters) and the serialized,
// lock-guarded write wrapper built on them (`runSerializedCommandWrite`).
import { createLogger } from '../shared/logger';
import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { normalizeCommandInputs } from './commandStringUtils';
import { CommandConflictError } from './commandErrors';
import { acquireNamedLocks, getSortedCommandLockNames, releaseNamedLocks, runWithDeadlockRetry } from './commandLocks';
import { buildInClausePlaceholders, type SqlExecutor } from './utils';

const log = createLogger('DB');

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
 * @param options.guildId - When given, scopes the check to counters in this guild only (the same
 *   trigger/check command may exist in a different guild's counter without colliding). Omit to
 *   check across every guild's counters — used when validating a *global* custom_command
 *   trigger, which must not collide with any guild's counter.
 * @returns The SQL and params to run via {@link executeExistsCheck}.
 */
function buildCounterExistsCheckPlan(
  placeholders: string,
  normalizedCommands: string[],
  options?: { excludeCustomCommandId?: number; excludeCounterId?: number; guildId?: string },
): SqlExistsCheckPlan {
  let sql = `SELECT 1 FROM counter WHERE (trigger_command IN (${placeholders}) OR check_command IN (${placeholders}))`;
  const params: Array<string | number> = [...normalizedCommands, ...normalizedCommands];

  if (options?.guildId !== undefined) {
    sql += ' AND guild_id = ?';
    params.push(options.guildId);
  }

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
 * @param options - Ids to exclude from the collision check, if updating an existing row, and
 *   `guildId` to scope the counter-table half of the check (see {@link buildCounterExistsCheckPlan}).
 *   `guildId` has no effect on the custom_command half of the check, which is always global.
 * @param executor - Query executor to run the checks on; defaults to the pool, but a
 *   transaction connection is passed when called from {@link runSerializedCommandWrite}.
 * @param checks - Which tables to check; both default to enabled.
 * @returns True if any command in `commandOrCommands` is already taken.
 */
export async function isAnyCommandTakenAcrossTables(
  commandOrCommands: string | string[],
  options?: { excludeCustomCommandId?: number; excludeCounterId?: number; guildId?: string },
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

// ─── Serialized write ─────────────────────────────────────────────────────────

/**
 * Runs `writeOperation` inside a transaction, serialized against other writers of the same
 * command(s) via MySQL named locks, with a fresh trigger-collision check and automatic
 * retry on deadlock.
 *
 * Acquires a named lock per command in `commandOrCommands` (sorted, to avoid lock-order
 * deadlocks across concurrent multi-command writes), then — for up to
 * `MAX_DEADLOCK_RETRIES` (see `commandLocks.ts`) attempts — opens a transaction, re-checks for a trigger
 * collision against whichever tables `checks` enables (guarding against a race between the
 * caller's earlier check and now), runs `writeOperation`, and commits. A `ER_LOCK_DEADLOCK`
 * during a non-final attempt rolls back and retries; any other error (including a collision,
 * which throws {@link CommandConflictError}) rolls back and propagates immediately. Lock
 * release is attempted and the connection returned to the pool in a `finally`; a release
 * failure is logged and swallowed rather than masking the original error, and destroys the
 * connection instead of returning it (see `releaseNamedLock` in `commandLocks.ts`) — including a caller-supplied
 * one, since it may otherwise keep holding the lock.
 * @param commandOrCommands - The command(s) this write claims; also used for the collision check.
 * @param options - Ids to exclude from the collision check, if updating an existing row, and
 *   `guildId` to scope the counter-table half of the check to one guild (see
 *   {@link isAnyCommandTakenAcrossTables}). `connection` runs the write on a connection the caller
 *   already holds (e.g. one holding other named locks) instead of taking a second one from the
 *   pool — which could otherwise starve the pool under load; the caller keeps ownership and
 *   releases it, while the trigger locks taken here are still released here.
 * @param writeOperation - The transactional write to perform once locks are held and no collision exists.
 * @param checks - Which tables to include in the collision check; both default to enabled.
 * @returns The value returned by `writeOperation`.
 * @throws {@link CommandConflictError} if a collision is detected.
 */
export async function runSerializedCommandWrite<T>(
  commandOrCommands: string | string[],
  options: {
    excludeCustomCommandId?: number;
    excludeCounterId?: number;
    guildId?: string;
    connection?: mysql.PoolConnection;
  } | undefined,
  writeOperation: (connection: mysql.PoolConnection) => Promise<T>,
  checks: { includeCustomCommandTable?: boolean; includeCounterTable?: boolean } = {
    includeCustomCommandTable: true,
    includeCounterTable: true,
  },
): Promise<T> {
  const normalizedCommands = normalizeCommandInputs(commandOrCommands);
  const lockNames = getSortedCommandLockNames(normalizedCommands);
  const callerConnection = options?.connection;
  let connection: mysql.PoolConnection | null = null;

  try {
    connection = callerConnection ?? await getPool().getConnection();
    const conn = connection;
    await acquireNamedLocks(conn, lockNames);

    return await runWithDeadlockRetry(conn, 'runSerializedCommandWrite', async () => {
      // Re-checks for a trigger collision on every attempt (a race between the caller's earlier
      // check and now, or a fresh collision from another writer since the last attempt), then
      // runs the caller's write. Returns `writeOperation`'s result, or throws
      // `CommandConflictError` on a collision — `runWithDeadlockRetry` rolls back and rethrows
      // either way, retrying only if the error is a deadlock.
      if (await isAnyCommandTakenAcrossTables(normalizedCommands, options, conn, checks)) {
        throw new CommandConflictError(normalizedCommands);
      }
      return writeOperation(conn);
    });
  } finally {
    if (connection) {
      let released = false;
      try { released = await releaseNamedLocks(connection, lockNames); } catch (err) { log.warn('Failed to release named locks:', err); }
      // A failed release already destroyed the connection — don't hand it back to the pool.
      if (!callerConnection && released) connection.release();
    }
  }
}
