import mysql from 'mysql2/promise';
import { testDatabasesIn, type TestDbSettings } from './realDbSettings';

// Server-level helpers for `npm run test:db`. Kept free of the app's config, so the global setup
// can use them in the main Vitest process, where no app settings exist.

/**
 * Opens a connection to the test server that can run several statements per query.
 * @param settings Connection settings from `readTestDbSettings`.
 * @param database Database to select, if any.
 * @returns The open connection; the caller ends it.
 */
export async function openTestServerConnection(settings: TestDbSettings, database?: string): Promise<mysql.Connection> {
  return mysql.createConnection({ ...settings, database, multipleStatements: true });
}

/**
 * Drops every scratch database (see `TEST_DATABASE_PREFIX`) on the server, and nothing else.
 * @param conn Connection to the test server.
 * @returns The names of the databases dropped.
 */
export async function dropTestDatabases(conn: mysql.Connection): Promise<string[]> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>('SHOW DATABASES');
  const names = testDatabasesIn(rows.map((r) => String(Object.values(r)[0])));
  for (const name of names) await conn.query(`DROP DATABASE \`${name}\``);
  return names;
}
