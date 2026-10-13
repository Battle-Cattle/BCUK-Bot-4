import { vi } from 'vitest';

/** Poll interval used by `waitFor`, in milliseconds — see its JSDoc for why it's not Vitest's 50ms default. */
export const WAIT_FOR_INTERVAL_MS = 1;

/**
 * `vi.waitFor` with a 1ms poll interval instead of Vitest's 50ms default. Most callers wait on a
 * mocked async chain that settles within a few microtasks, so the default interval just adds ~50ms
 * of idle time to every test that doesn't pass on the first (synchronous) check. Same timeout and
 * semantics as `vi.waitFor` otherwise; pass `options` to override either.
 * @param callback - Assertion (or value-returning check) to retry until it stops throwing.
 * @param options - Optional `vi.waitFor` options; `interval` defaults to `WAIT_FOR_INTERVAL_MS`.
 * @returns Whatever `callback` returns once it succeeds.
 */
export function waitFor<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  return vi.waitFor(callback, { interval: WAIT_FOR_INTERVAL_MS, ...options });
}
