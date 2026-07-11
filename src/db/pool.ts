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
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}
