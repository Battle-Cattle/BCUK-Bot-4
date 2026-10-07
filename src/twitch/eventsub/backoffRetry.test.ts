import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackoffRetry } from './backoffRetry';

describe('BackoffRetry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('doubles the delay per attempt, capped at the maximum', () => {
    const retry = new BackoffRetry(1_000, 3_000, 10);
    const delays = [1, 2, 3, 4].map(() => retry.schedule(() => {}));
    expect(delays).toEqual([1_000, 2_000, 3_000, 3_000]);
    expect(retry.attempts).toBe(4);
  });

  it('runs the callback once after the delay and is no longer pending', () => {
    const retry = new BackoffRetry(1_000, 10_000, 5);
    const run = vi.fn();
    retry.schedule(run);
    expect(retry.pending).toBe(true);
    vi.advanceTimersByTime(999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(retry.pending).toBe(false);
  });

  it('gives up (returns null, schedules nothing) once maxAttempts is reached', () => {
    const retry = new BackoffRetry(1_000, 10_000, 2);
    retry.schedule(() => {});
    retry.schedule(() => {});
    const run = vi.fn();
    expect(retry.schedule(run)).toBeNull();
    expect(retry.pending).toBe(false);
    vi.runAllTimers();
    expect(run).not.toHaveBeenCalled();
  });

  it('schedule replaces a pending retry instead of stacking a second timer', () => {
    const retry = new BackoffRetry(1_000, 10_000, 5);
    const first = vi.fn();
    const second = vi.fn();
    retry.schedule(first);
    retry.schedule(second);
    vi.runAllTimers();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('cancel keeps the attempt count; reset starts the backoff over', () => {
    const retry = new BackoffRetry(1_000, 10_000, 5);
    const run = vi.fn();
    retry.schedule(run);
    retry.cancel();
    expect(retry.pending).toBe(false);
    expect(retry.attempts).toBe(1);
    expect(retry.schedule(run)).toBe(2_000);
    retry.reset();
    expect(retry.attempts).toBe(0);
    expect(retry.pending).toBe(false);
    expect(retry.schedule(run)).toBe(1_000);
    vi.runAllTimers();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
