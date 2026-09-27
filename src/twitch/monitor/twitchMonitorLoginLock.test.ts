import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withLoginLock } from './twitchMonitorLoginLock';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── withLoginLock ────────────────────────────────────────────────────────────
// Guards against the poll loop and triggerImmediateLiveCheck racing on the same
// login's liveStates entry (CodeRabbit review finding on PR #303).

describe('withLoginLock', () => {
  it('serializes operations queued for the same login', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = withLoginLock('alice', () => new Promise<void>((resolve) => {
      releaseFirst = () => { order.push('first'); resolve(); };
    }));
    const second = withLoginLock('alice', async () => { order.push('second'); });

    await Promise.resolve(); // let microtasks settle without releasing the first op
    expect(order).toEqual([]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('does not block operations queued for a different login', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = withLoginLock('alice', () => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    const second = withLoginLock('bob', async () => { order.push('bob'); });

    await second;
    expect(order).toEqual(['bob']);

    releaseFirst();
    await first;
  });

  it('still processes the next queued operation after a failure', async () => {
    await expect(withLoginLock('alice', async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    const order: string[] = [];
    await withLoginLock('alice', async () => { order.push('after-failure'); });
    expect(order).toEqual(['after-failure']);
  });

  it('resolves with the wrapped function\'s return value', async () => {
    const result = await withLoginLock('alice', async () => 42);
    expect(result).toBe(42);
  });

  it('times out a hung fn and still releases the queue for a later operation on the same login', async () => {
    const hung = withLoginLock('alice', () => new Promise<void>(() => {}));
    const assertion = expect(hung).rejects.toThrow('Login lock (alice) timed out after 20000ms');
    await vi.advanceTimersByTimeAsync(20_000); // LOGIN_LOCK_TIMEOUT_MS
    await assertion;

    const order: string[] = [];
    await withLoginLock('alice', async () => { order.push('after-timeout'); });
    expect(order).toEqual(['after-timeout']);
  });

  it('reports isCurrent() as true for the duration of a normal (non-superseded) run', async () => {
    const seen: boolean[] = [];
    await withLoginLock('alice', async (isCurrent) => {
      seen.push(isCurrent());
      await Promise.resolve();
      seen.push(isCurrent());
    });
    expect(seen).toEqual([true, true]);
  });

  it('flips isCurrent() to false for a timed-out fn once a later operation for the same login has started', async () => {
    let isCurrentAfterResume!: () => boolean;
    let resumeStalled!: () => void;
    const stalled = withLoginLock('alice', (isCurrent) => {
      isCurrentAfterResume = isCurrent;
      return new Promise<void>((resolve) => { resumeStalled = resolve; });
    });
    const stalledAssertion = expect(stalled).rejects.toThrow('Login lock (alice) timed out after 20000ms');
    await vi.advanceTimersByTimeAsync(20_000); // LOGIN_LOCK_TIMEOUT_MS — frees the queue, stalled fn keeps "running"
    await stalledAssertion;

    // A later operation for the same login takes over the queue.
    await withLoginLock('alice', async () => {});

    // The original (still-running-in-the-background) fn must now see itself as superseded.
    expect(isCurrentAfterResume()).toBe(false);
    resumeStalled(); // let the original fn actually settle so it doesn't leak into later tests
  });
});
