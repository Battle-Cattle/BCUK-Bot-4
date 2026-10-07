// MySQL named-lock and deadlock-retry primitives used by every serialized command write. No
// table knowledge: the command-specific collision checks live in `commandWriteGuard.ts`.
import { createLogger } from '../shared/logger';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';

const log = createLogger('DB');

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
export function getSortedCommandLockNames(commands: string[]): string[] {
  return commands
    .slice()
    .sort((left, right) => {
      if (left === right) return 0;
      return left < right ? -1 : 1;
    })
    .map((command) => getCommandWriteLockName(command));
}

/**
 * Describes why `GET_LOCK` didn't grant a lock.
 * @param lockStatus - The `lock_status` value `GET_LOCK` returned (anything but `1`).
 * @param lockName - Name of the lock that was requested.
 * @returns A timeout message for `0`, an internal-error message for null, else an unexpected-result message.
 */
function lockFailureMessage(lockStatus: unknown, lockName: string): string {
  if (lockStatus === '0' || lockStatus === 0) return `Timed out acquiring command write lock '${lockName}'`;
  if (lockStatus == null) return `Internal error acquiring command write lock '${lockName}'`;
  return `Unexpected result acquiring command write lock '${lockName}'`;
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

  throw new Error(`${lockFailureMessage(lockStatus, lockName)} (lock_status=${String(lockStatus)}).`);
}

/**
 * Releases a MySQL named lock on `connection`, reporting whether it worked. Swallows and logs any
 * error — releasing must never block the caller's cleanup. If `RELEASE_LOCK` fails, the connection
 * is destroyed rather than left usable: the session may still hold the `GET_LOCK`, and handing it
 * back to the pool would keep that lock held indefinitely by an idle pooled connection. Destroying
 * the session makes MySQL drop every named lock it held. A later `connection.release()` by the
 * caller is a no-op on a destroyed pool connection, so existing callers stay safe.
 * @param connection - Pool connection the lock was acquired on.
 * @param lockName - Name of the lock to release.
 * @returns True if `RELEASE_LOCK` ran; false if it failed and the connection was destroyed.
 */
async function tryReleaseNamedLock(connection: mysql.PoolConnection, lockName: string): Promise<boolean> {
  try {
    await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
    return true;
  } catch (error) {
    log.warn(`Failed to release command write lock '${lockName}'; destroying connection so the lock can't leak back into the pool:`, error);
    connection.destroy();
    return false;
  }
}

/**
 * Releases a MySQL named lock on `connection`. Never rejects; on a failed `RELEASE_LOCK` the
 * connection is destroyed instead of being left to return to the pool still holding the lock
 * (see {@link tryReleaseNamedLock}).
 * @param connection - Pool connection the lock was acquired on.
 * @param lockName - Name of the lock to release.
 */
export async function releaseNamedLock(connection: mysql.PoolConnection, lockName: string): Promise<void> {
  await tryReleaseNamedLock(connection, lockName);
}

/**
 * Acquires each of `lockNames` in order (see {@link getSortedCommandLockNames} for why order matters).
 * @param connection - Pool connection to acquire the locks on.
 * @param lockNames - Lock names to acquire, in acquisition order.
 * @returns Resolves once every lock in `lockNames` is held.
 */
export async function acquireNamedLocks(connection: mysql.PoolConnection, lockNames: string[]): Promise<void> {
  for (const lockName of lockNames) {
    await acquireNamedLock(connection, lockName);
  }
}

/**
 * Releases `lockNames` in reverse-acquisition order. Stops at the first failed release: that
 * failure destroys the connection (see {@link tryReleaseNamedLock}), which already drops every named
 * lock the session held.
 * @param connection - Pool connection the locks were acquired on.
 * @param lockNames - Lock names to release, in the same order they were acquired.
 * @returns True if every lock was released; false if a release failed and the connection was destroyed.
 */
export async function releaseNamedLocks(connection: mysql.PoolConnection, lockNames: string[]): Promise<boolean> {
  for (const lockName of [...lockNames].reverse()) {
    if (!(await tryReleaseNamedLock(connection, lockName))) return false;
  }
  return true;
}

/**
 * Runs `body` inside a transaction on `connection`, for up to {@link MAX_DEADLOCK_RETRIES}
 * attempts: begins a transaction, runs `body`, and commits on success. On error, rolls back;
 * if the error is a deadlock and this wasn't the final attempt, logs and retries; otherwise
 * rethrows the original error, unless `exhaustedErrorMessage` is given, in which case a
 * deadlock on the final attempt throws a new `Error(exhaustedErrorMessage)` instead of the raw
 * driver error (a non-deadlock error always rethrows as-is, on any attempt). Factors out the
 * retry/transaction scaffolding shared by `runSerializedCommandWrite` (in `commandWriteGuard.ts`)
 * and `withDeadlockRetryAndTriggerLock` (in `commandAssignments.ts`), which differ only in how
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
