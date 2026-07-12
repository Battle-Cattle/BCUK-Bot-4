import { vi } from 'vitest';

/** Returns a mock logger with `info`/`warn`/`error`/`debug` vi.fn()s, matching the shape returned by `createLogger`. */
export function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}
