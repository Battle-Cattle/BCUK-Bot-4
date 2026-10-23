// The per-command-id named lock every command write and assignment takes first, so writes to one
// command serialize. Kept apart from `commandLocks.ts`, which has no pool or table knowledge.
import type mysql from 'mysql2/promise';
import { getPool } from './pool';
import { acquireNamedLock, releaseNamedLock } from './commandLocks';

/**
 * The MySQL named-lock name for a command id.
 * @param commandId - ID of the command to lock.
 * @returns `bcuk_cmdid_<commandId>`.
 */
export function commandIdLockName(commandId: number): string {
  return `bcuk_cmdid_${commandId}`;
}

/**
 * Takes a pool connection, holds the command's id lock on it while `fn` runs, then always releases
 * the lock and the connection, whether `fn` resolves or throws (or the lock can't be acquired).
 * @param commandId - ID of the command to lock.
 * @param fn - The work to run under the lock, given the connection that holds it (run any further
 *   locks and the transaction on this same connection).
 * @returns Resolves with `fn`'s result; rejects with its error, or the lock-acquire error.
 */
export async function withCommandIdLock<T>(
  commandId: number,
  fn: (connection: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await getPool().getConnection();
  const lockName = commandIdLockName(commandId);
  try {
    await acquireNamedLock(connection, lockName);
    return await fn(connection);
  } finally {
    await releaseNamedLock(connection, lockName);
    connection.release();
  }
}
