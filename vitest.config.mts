import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The ts-node smoke test spawns a fresh Node process that type-checks the whole project
 * (~7s of CPU), so it runs on its own via `npm run test:toolchain` (see vitest.toolchain.config.mts)
 * instead of in every `npm test` — CI still runs it on every push.
 */
export const TOOLCHAIN_TEST = 'src/shared/tsNodeDevToolchain.test.ts';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, TOOLCHAIN_TEST],
    coverage: {
      provider: 'v8',
      reporter: [['text', { file: 'coverage-report.txt' }], 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
    // Persist transformed modules across runs, so a rerun skips most of the esbuild transform
    // work. Kept outside node_modules so it survives `npm ci` (which deploy.sh runs every time);
    // deploy.sh and CI drop it whenever package-lock.json changes.
    fsModuleCache: true,
    fsModuleCachePath: '.vitest-cache',
  },
});
