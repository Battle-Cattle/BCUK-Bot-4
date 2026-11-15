import { appEnvFor, readTestDbSettings, workerDatabaseName } from './realDbSettings';

// Side-effect module for `npm run test:db`: points the app's config at this worker's scratch
// database. realDb.setup.ts imports it ahead of everything else, so it runs before any module
// loads src/shared/config.ts, which reads the settings once on load.
Object.assign(process.env, appEnvFor(readTestDbSettings(process.env), workerDatabaseName(process.env.VITEST_POOL_ID)));
