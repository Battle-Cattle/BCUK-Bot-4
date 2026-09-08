import mysql, { type PoolConnection } from 'mysql2/promise';
import { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from '../shared/config';

let pool: mysql.Pool | undefined;

/** Returns the shared connection pool, creating it on first use. */
export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      supportBigNumbers: true,
      bigNumberStrings: true,
      waitForConnections: true,
      connectionLimit: 15,
      queueLimit: 100,
      connectTimeout: 10_000,
      // `connectTimeout` only bounds opening a *new* connection. Without these, a
      // connection whose socket goes silently dead (e.g. a network drop that never
      // sends a TCP RST/FIN) can sit hung indefinitely — mysql2 only frees a pooled
      // connection on an 'error'/'end' event, which a true black hole never fires,
      // so stuck connections would otherwise leak out of the 15-connection pool
      // permanently. TCP keepalive probes detect that dead socket and surface it as
      // a connection error instead, so the pool can evict and replace it.
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
    });
  }
  return pool;
}

/** Closes the shared connection pool, if one has been created, and clears the singleton. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * Runs `work` inside a transaction on an already-acquired `conn`: begins the transaction,
 * invokes `work`, and commits once it resolves. If `work` throws, the transaction is rolled
 * back — rollback failures are swallowed so the original error still propagates — and the
 * error is rethrown. Does not acquire or release `conn`; the caller owns its lifecycle, which
 * is what lets a caller like `removeCustomCommand` (in `customCommands.ts`) hold the same
 * connection across a named-lock acquire/release that must wrap the transaction.
 * @param conn Pool connection to run the transaction on.
 * @param work Callback that performs the transactional work.
 * @returns The value returned by `work`, once the transaction has committed.
 */
export async function runInTransaction<T>(conn: PoolConnection, work: () => Promise<T>): Promise<T> {
  try {
    await conn.beginTransaction();
    const result = await work();
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  }
}

/**
 * Runs `work` inside a database transaction: acquires a connection, begins the
 * transaction, invokes `work(conn)`, and commits once it resolves. If `work`
 * throws (including a caller-defined sentinel error used to signal an early
 * "not found" exit), the transaction is rolled back — rollback failures are
 * swallowed (mirroring every hand-written transaction this replaces) so the
 * original error still propagates — and the error is rethrown. The connection
 * is always released in a `finally`, regardless of outcome.
 * @param work Callback that receives the transaction's connection and performs the work.
 * @returns The value returned by `work`, once the transaction has committed.
 */
export async function withTransaction<T>(work: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    return await runInTransaction(conn, () => work(conn));
  } finally {
    conn.release();
  }
}

/**
 * Like {@link withTransaction}, but for the common "load a row, maybe mutate it,
 * bail out if it doesn't exist" shape: `work` is passed a `notFound()` function
 * that rolls back the transaction and resolves this call to `null`, instead of
 * every call site declaring its own throwaway sentinel error class to get the
 * same effect. Any other thrown error still propagates and rejects as usual.
 * @param work Callback that receives the transaction's connection and a
 *   `notFound()` escape hatch to call (and `return`) when the target row is missing.
 * @returns The value returned by `work`, or null if `work` called `notFound()`.
 */
export async function withTransactionOrNotFound<T>(
  work: (conn: PoolConnection, notFound: () => never) => Promise<T>,
): Promise<T | null> {
  const notFoundSignal = new Error('withTransactionOrNotFound: not found');
  try {
    return await withTransaction((conn) => work(conn, () => { throw notFoundSignal; }));
  } catch (err) {
    if (err === notFoundSignal) return null;
    throw err;
  }
}
