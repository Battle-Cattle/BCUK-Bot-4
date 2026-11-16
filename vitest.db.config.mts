import { defineConfig } from 'vitest/config';
import { DB_TESTS } from './vitest.config.mts';

/**
 * Runs the real-MySQL tests (`*.db.test.ts`) that the main config excludes: `npm run test:db`.
 * Needs the `TEST_DB_*` settings (see the README's "Database tests"); the global setup fails
 * with a clear message without them, rather than skipping.
 */
export default defineConfig({
  test: {
    include: [DB_TESTS],
    globalSetup: ['src/test-utils/realDb.globalSetup.ts'],
    // Runs before each file's own imports, so the app's config loads pointed at the worker's
    // scratch database (one per worker, migrated on first use and emptied after every test).
    setupFiles: ['src/test-utils/realDb.setup.ts'],
    pool: 'vmThreads',
    vmMemoryLimit: '300MB',
    maxWorkers: '100%',
    coverage: {
      provider: 'v8',
      reporter: ['lcov'],
      reportsDirectory: 'coverage-db',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
    fsModuleCache: true,
    fsModuleCachePath: '.vitest-cache',
  },
});
