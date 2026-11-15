import type mysql from 'mysql2/promise';
import { closePool, runMigrations } from '../db';
import { clearTablesSql, readTestDbSettings, workerDatabaseName } from './realDbSettings';
import { openTestServerConnection } from './realDbServer';

// The real-MySQL harness behind `npm run test:db` (vitest.db.config.mts). The global setup drops
// every scratch database left from an earlier run; each worker then creates and migrates its own
// the first time one of its files runs (`prepareWorkerDatabase`, from realDb.setup.ts), and the
// worker's later files reuse it. Tests use the app's real pool (`getPool()`), and every table is
// emptied after each test, so the next test — or the next file on the worker — starts clean.
// Per-test transactions rolled back afterwards can't work here: the code under test opens its
// own transactions, and in MySQL a nested BEGIN commits the outer one.

/** Tables never emptied between tests: the migration runner's record of what it has applied. */
const KEEP_TABLES = new Set(['schema_migrations']);

/** A worker's migrated scratch database, as the setup file holds it. */
export interface WorkerDatabase {
  /** The database's name. */
  name: string;
  /** Empties every table but `schema_migrations`, in one round trip. */
  clearTables(): Promise<void>;
  /** Drops and recreates the database empty, for a test that must start from no schema at all. */
  recreateEmpty(): Promise<void>;
  /** Ends the harness's own connection and the app's pools. */
  close(): Promise<void>;
}

let current: WorkerDatabase | undefined;

/**
 * The worker database the setup file prepared for the running test file.
 * @returns The prepared database.
 * @throws If called outside the `test:db` suite, where nothing prepared one.
 */
export function workerDatabase(): WorkerDatabase {
  if (!current) throw new Error('No worker database: real-database tests run under `npm run test:db` (vitest.db.config.mts)');
  return current;
}

/**
 * Lists the tables the migrations created, minus the ones kept between tests.
 * @param conn Connection with the worker database selected.
 * @returns Table names to empty between tests.
 */
async function tablesToClear(conn: mysql.Connection): Promise<string[]> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    'SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = \'BASE TABLE\'',
  );
  return rows.map((r) => String(r.name)).filter((name) => !KEEP_TABLES.has(name));
}

/**
 * Creates this worker's scratch database if needed, brings its schema up to date through the
 * real migration runner (`src/db/migrations.ts`), then empties it. The app's config must already
 * point at it (realDbEnv.ts).
 * @param env Environment holding the `TEST_DB_*` settings and `VITEST_POOL_ID`.
 * @returns The worker's database, ready for tests; {@link workerDatabase} returns it too.
 * @throws If the `TEST_DB_*` settings are missing, the server can't be reached, or a migration fails.
 */
export async function prepareWorkerDatabase(env: NodeJS.ProcessEnv): Promise<WorkerDatabase> {
  const name = workerDatabaseName(env.VITEST_POOL_ID);
  const conn = await openTestServerConnection(readTestDbSettings(env));
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\`; USE \`${name}\``);
  await runMigrations();
  const clearSql = clearTablesSql(await tablesToClear(conn));

  const clearTables = async (): Promise<void> => {
    if (clearSql) await conn.query(clearSql);
  };
  await clearTables();
  current = {
    name,
    clearTables,
    recreateEmpty: async () => {
      await conn.query(`DROP DATABASE \`${name}\`; CREATE DATABASE \`${name}\`; USE \`${name}\``);
    },
    close: async () => {
      current = undefined;
      await Promise.allSettled([conn.end(), closePool()]);
    },
  };
  return current;
}
