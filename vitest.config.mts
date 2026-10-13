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
    // Run each test file in a fresh VM context on a reused worker thread instead of a fresh
    // child process per file (the default `forks` pool). Module isolation between files is the
    // same, but skipping the per-file process spawn and Node bootstrap roughly halves `npm test`
    // (~22s -> ~10s). vm contexts hold more memory, so workers are recycled once they pass
    // `vmMemoryLimit`. 300MB peaks around +1.4GB over idle (vs ~+0.3GB for forks) — fine on the
    // 12GB deploy server, where deploy.sh runs this next to tsc and the live bot; 75MB would hold
    // it to ~+0.6GB for ~2s more test time if memory ever gets tight.
    // If a new test trips over a cross-context `instanceof` on a Node built-in, prefer fixing the
    // assertion (e.g. check `.name`/`.code`); a separate `projects` entry with `pool: 'forks'` is the fallback.
    pool: 'vmThreads',
    vmMemoryLimit: '300MB',
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
