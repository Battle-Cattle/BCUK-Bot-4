import { vi } from 'vitest';

/**
 * Returns a mock logger with `info`/`warn`/`error`/`debug` vi.fn()s, matching the shape returned by `createLogger`.
 * @returns A new object with `info`, `warn`, `error` and `debug` mocks.
 */
export function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}
