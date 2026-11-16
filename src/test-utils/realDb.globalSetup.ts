import { dropTestDatabases, openTestServerConnection } from './realDbServer';
import { readTestDbSettings } from './realDbSettings';

/**
 * Global setup for `npm run test:db`: checks the `TEST_DB_*` settings and that the server answers
 * before any worker starts (so a missing server fails once, clearly), and drops the scratch
 * databases an earlier run left behind, so every run migrates from an empty database.
 * @returns Teardown that drops this run's scratch databases.
 * @throws If the settings are missing or the server can't be reached.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const settings = readTestDbSettings(process.env);
  const conn = await openTestServerConnection(settings).catch((err: unknown) => {
    throw new Error(`Couldn't connect to the test MySQL server at ${settings.host}:${settings.port}: ${(err as Error).message}`, { cause: err });
  });
  try {
    await dropTestDatabases(conn);
  } finally {
    await conn.end();
  }
  return async () => {
    const teardownConn = await openTestServerConnection(settings);
    try {
      await dropTestDatabases(teardownConn);
    } finally {
      await teardownConn.end();
    }
  };
}
