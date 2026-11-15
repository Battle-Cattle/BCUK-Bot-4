import { afterAll, afterEach, beforeAll } from 'vitest';
import { prepareWorkerDatabase, type WorkerDatabase } from './realDb';

// Side-effect module for `npm run test:db`, imported by realDb.setup.ts (after realDbEnv.ts):
// registers the hooks that prepare the worker's scratch database before the file's tests, empty
// it after each one and close the connections after the last.

let db: WorkerDatabase | undefined;

beforeAll(async () => {
  db = await prepareWorkerDatabase(process.env);
});

afterEach(async () => {
  await db?.clearTables();
});

afterAll(async () => {
  await db?.close();
});
