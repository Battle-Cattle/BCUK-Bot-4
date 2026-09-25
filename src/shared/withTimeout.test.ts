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

  it('rejects with a non-Error rejection reason unchanged', async () => {
    const result = withTimeout(Promise.reject('plain string'), 1_000, 'test op');
    await expect(result).rejects.toBe('plain string');
  });

  it('clears its timer once the wrapped promise settles, so no timeout fires afterwards', async () => {
    await withTimeout(Promise.resolve('done'), 1_000, 'test op');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still observes a wrapped promise that rejects after the timeout has already won', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let rejectLate!: (err: Error) => void;
      const late = new Promise<never>((_resolve, reject) => { rejectLate = reject; });
      const result = withTimeout(late, 1_000, 'test op');
      const assertion = expect(result).rejects.toThrow('test op timed out after 1000ms');
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      rejectLate(new Error('late failure'));
      // Unhandled rejections are reported after the microtask queue drains, so wait a real macrotask.
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('unrefs its internal timer so a long-lived timeout cannot keep the event loop alive on its own', () => {
    const unref = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockReturnValue({ unref, ref: vi.fn() } as unknown as NodeJS.Timeout);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});

    try {
      void withTimeout(new Promise(() => {}), 1_000, 'test op').catch(() => {});
      expect(unref).toHaveBeenCalledOnce();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});
