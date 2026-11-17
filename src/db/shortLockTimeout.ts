// A connection with a short InnoDB lock wait, for writes and locking reads that should fail fast
// under contention rather than hang for the server's default 50s.
import type mysql from 'mysql2/promise';
import { getPool } from './pool';
import { createLogger } from '../shared/logger';

const log = createLogger('DB');

/**
 * Runs `fn` on a dedicated connection with a short (5s) `innodb_lock_wait_timeout`, so callers
 * fail fast instead of hanging up to the default 50s under lock contention. The timeout is reset
 * to the session default and the connection released before returning; if that reset fails, the
 * connection is destroyed instead of being returned to the pool.
 * @param fn Callback that receives the connection and performs the work.
 * @returns The value returned by `fn`.
 */
export async function withShortLockTimeout<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const connection = await getPool().getConnection();
  try {
    await connection.execute('SET SESSION innodb_lock_wait_timeout = 5');
    return await fn(connection);
  } finally {
    try {
      await connection.execute('SET SESSION innodb_lock_wait_timeout = DEFAULT');
      connection.release();
    } catch (e) {
      // Don't hand a connection still carrying the 5s timeout back to the shared pool, or an
      // unrelated transaction that later picks it up would fail fast under normal contention.
      log.warn('connection.execute: failed to reset innodb_lock_wait_timeout to DEFAULT; destroying connection:', e);
      connection.destroy();
    }
  }
}
