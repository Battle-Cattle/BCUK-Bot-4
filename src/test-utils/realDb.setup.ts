// Setup file for `npm run test:db` (vitest.db.config.mts), run before each test file.
// realDbEnv must stay the first import: it points the app's config at this worker's scratch
// database before anything (including realDb's own imports) loads src/shared/config.ts.
import './realDbEnv';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { prepareWorkerDatabase, type WorkerDatabase } from './realDb';

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
