import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTimeout } from './withTimeout';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout', () => {
  it('resolves with the wrapped promise\'s value when it settles before the timeout', async () => {
    const result = withTimeout(Promise.resolve('done'), 1_000, 'test op');
    await expect(result).resolves.toBe('done');
  });

  it('rejects with the wrapped promise\'s own rejection reason when it settles before the timeout', async () => {
    const reason = new Error('boom');
    const result = withTimeout(Promise.reject(reason), 1_000, 'test op');
    await expect(result).rejects.toBe(reason);
  });

  it('rejects with a labeled timeout error when the wrapped promise never settles', async () => {
    const result = withTimeout(new Promise(() => {}), 1_000, 'test op');
    const assertion = expect(result).rejects.toThrow('test op timed out after 1000ms');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});
