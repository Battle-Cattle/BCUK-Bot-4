import mysql, { type PoolConnection } from 'mysql2/promise';
import { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from '../shared/config';

let pool: mysql.Pool | undefined;
let sessionPool: mysql.Pool | undefined;

// `connectTimeout` only bounds opening a *new* connection. Without these, a connection whose
// socket goes silently dead (e.g. a network drop that never sends a TCP RST/FIN) can sit hung
// indefinitely — mysql2 only frees a pooled connection on an 'error'/'end' event, which a true
// black hole never fires, so stuck connections would otherwise leak out of a pool permanently.
// TCP keepalive probes detect that dead socket and surface it as a connection error instead, so
// the pool can evict and replace it. Shared by both pools below.
const KEEPALIVE_OPTIONS = { enableKeepAlive: true, keepAliveInitialDelay: 10_000 } as const;

/**
 * Connection settings shared by the pool and the migration runner's dedicated connection, so
 * both talk to the same database the same way (including BIGINT columns as strings).
 * @returns Host, credentials, database and number-handling options for `mysql2`.
 */
export function connectionOptions(): mysql.ConnectionOptions {
  return {
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectTimeout: 10_000,
  };
}

/**
 * Returns the shared connection pool, creating it on first use.
 * @returns The process-wide mysql2 pool.
 */
export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      ...connectionOptions(),
      waitForConnections: true,
      connectionLimit: 15,
      queueLimit: 100,
      ...KEEPALIVE_OPTIONS,
    });
  }
  return pool;
}

/**
 * Returns the web panel's session-store pool, creating it on first use. It is kept apart from
 * {@link getPool}'s on purpose: express-session looks a session up on every request that carries
 * a cookie, ahead of the rate limiters, so on the shared pool a burst of panel requests could fill
 * its bounded queue and make the bot's own queries fail. Its size and queue are mysql2's defaults,
 * the same as the pool express-mysql-session used to open for itself; what it adds is the shared
 * connection settings and keepalive, and being ended by {@link closePool} at shutdown.
 * @returns The process-wide mysql2 pool for session storage.
 */
export function getSessionPool(): mysql.Pool {
  sessionPool ??= mysql.createPool({ ...connectionOptions(), ...KEEPALIVE_OPTIONS });
  return sessionPool;
}

/** Closes the shared and session-store pools, if they have been created, and clears both singletons. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
  if (sessionPool) {
    await sessionPool.end();
    sessionPool = undefined;
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
