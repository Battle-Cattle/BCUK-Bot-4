import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const config = fs.readFileSync(path.join(__dirname, '../../vitest.config.mts'), 'utf8');

describe('vitest.config.mts testTimeout', () => {
  // The config sits outside tsconfig's `src` root, so it is read as text rather than imported.
  it('gives a CI runner 15s and keeps the 5s default locally', () => {
    expect(config).toContain('export const DEFAULT_TEST_TIMEOUT_MS = 5_000;');
    expect(config).toContain('export const CI_TEST_TIMEOUT_MS = 15_000;');
    expect(config).toContain('testTimeout: process.env.CI ? CI_TEST_TIMEOUT_MS : DEFAULT_TEST_TIMEOUT_MS,');
  });
});
