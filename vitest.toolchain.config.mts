import { defineConfig } from 'vitest/config';
import { TOOLCHAIN_TEST } from './vitest.config.mts';

/** Runs only the ts-node dev toolchain smoke test that the main config excludes (`npm run test:toolchain`). */
export default defineConfig({
  test: {
    include: [TOOLCHAIN_TEST],
  },
});
