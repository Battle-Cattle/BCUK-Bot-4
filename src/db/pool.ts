import mysql from 'mysql2/promise';
import { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from '../config';

let pool: mysql.Pool | undefined;

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
      queueLimit: 0,
      connectTimeout: 10_000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
