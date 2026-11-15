// Settings for the real-MySQL test suite (`npm run test:db`). Kept free of DB/config imports so
// the normal `npm test` run can cover it without a database.

/** Connection settings for the MySQL server `test:db` runs against. */
export interface TestDbSettings {
  host: string;
  port: number;
  user: string;
  password: string;
}

/** Every scratch database the suite creates starts with this, so cleanup can never touch another one. */
export const TEST_DATABASE_PREFIX = 'bcuk_test_';

const DEFAULT_PORT = 3306;
const MAX_PORT = 65535;

/** How to start a local server, quoted in the error when the settings are missing. */
const SETUP_HINT = 'Start one with `docker compose -f docker-compose.test-db.yml up -d --wait` and set '
  + 'TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=3307 TEST_DB_USER=root TEST_DB_PASSWORD=test (see the README\'s "Database tests").';

/**
 * Reads the `TEST_DB_*` settings. They are separate from the app's `DB_*` ones on purpose: the
 * suite drops and recreates databases, so it must never pick up a real database from `.env`.
 * @param env Environment to read, normally `process.env`.
 * @returns The connection settings.
 * @throws If `TEST_DB_HOST`, `TEST_DB_USER` or `TEST_DB_PASSWORD` is unset, or `TEST_DB_PORT` isn't a valid port.
 */
export function readTestDbSettings(env: NodeJS.ProcessEnv): TestDbSettings {
  const host = env.TEST_DB_HOST?.trim();
  const user = env.TEST_DB_USER?.trim();
  const password = env.TEST_DB_PASSWORD;
  const missing = [!host && 'TEST_DB_HOST', !user && 'TEST_DB_USER', password === undefined && 'TEST_DB_PASSWORD'].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`npm run test:db needs a MySQL server to run against, but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ${SETUP_HINT}`);
  }
  return { host: host!, user: user!, password: password!, port: parsePort(env.TEST_DB_PORT) };
}

/**
 * Parses `TEST_DB_PORT`, defaulting to MySQL's standard port when unset or blank.
 * @param raw The variable's value, if set.
 * @returns The port number.
 * @throws If it is set to anything but a whole number from 1 to 65535.
 */
function parsePort(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_PORT;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`Invalid TEST_DB_PORT: must be a whole number from 1 to ${MAX_PORT}, got '${trimmed}'`);
  }
  return port;
}

/**
 * Picks the suite's scratch databases out of a server's database list.
 * @param names Every database on the server.
 * @returns The ones whose names start with {@link TEST_DATABASE_PREFIX}.
 */
export function testDatabasesIn(names: readonly string[]): string[] {
  return names.filter((name) => name.startsWith(TEST_DATABASE_PREFIX));
}

/**
 * Names the scratch database one Vitest worker uses. Test files on the same worker run one after
 * another, so they can share it as long as each test leaves it empty.
 * @param poolId Vitest's `VITEST_POOL_ID` for the worker.
 * @returns The database name.
 * @throws If `poolId` isn't a positive whole number (it ends up in SQL as an identifier).
 */
export function workerDatabaseName(poolId: string | undefined): string {
  if (!poolId || !/^[1-9]\d*$/.test(poolId)) throw new Error(`Expected VITEST_POOL_ID to be a positive whole number, got '${poolId}'`);
  return `${TEST_DATABASE_PREFIX}w${poolId}`;
}

/**
 * The app's required non-database settings, filled with placeholders so `src/shared/config.ts`
 * loads (nothing in the DB layer uses them), and a log level that keeps the migration runner's
 * per-file progress lines out of the test output.
 */
const PLACEHOLDER_APP_ENV: Readonly<Record<string, string>> = {
  DISCORD_TOKEN: 'test-discord-token',
  TWITCH_USERNAME: 'test-bot',
  TWITCH_CLIENT_ID: 'test-twitch-client-id',
  TWITCH_CLIENT_SECRET: 'test-twitch-client-secret',
  SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  DISCORD_CLIENT_ID: 'test-discord-client-id',
  DISCORD_CLIENT_SECRET: 'test-discord-client-secret',
  DISCORD_CALLBACK_URL: 'http://localhost/auth/discord/callback',
  LOG_LEVEL: 'warn',
};

/**
 * Builds the environment the app's config should load with: the test server and worker database
 * as `DB_*` (overriding anything a `.env` file would supply, since dotenv never overwrites a set
 * variable), plus placeholders for the other required settings.
 * @param settings Connection settings from {@link readTestDbSettings}.
 * @param database The worker's scratch database.
 * @returns Variables to assign onto `process.env` before the config module loads.
 */
export function appEnvFor(settings: TestDbSettings, database: string): Record<string, string> {
  return {
    ...PLACEHOLDER_APP_ENV,
    DB_HOST: settings.host,
    DB_PORT: String(settings.port),
    DB_USER: settings.user,
    DB_PASSWORD: settings.password,
    DB_NAME: database,
  };
}

/**
 * Builds one multi-statement query that empties every given table, with foreign-key checks off
 * so the order doesn't matter. `DELETE` rather than `TRUNCATE`: on the near-empty tables a test
 * leaves behind it is much cheaper than `TRUNCATE`'s drop-and-recreate.
 * @param tables Table names to empty.
 * @returns The SQL, or an empty string when there is nothing to empty.
 */
export function clearTablesSql(tables: readonly string[]): string {
  if (tables.length === 0) return '';
  const deletes = tables.map((t) => `DELETE FROM \`${t.replaceAll('`', '``')}\`;`).join(' ');
  return `SET FOREIGN_KEY_CHECKS = 0; ${deletes} SET FOREIGN_KEY_CHECKS = 1;`;
}
