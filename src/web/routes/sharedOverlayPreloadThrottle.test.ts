import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createByteBudget, createThrottle, PRELOAD_SLICE_BYTES } from './sharedOverlayPreloadThrottle';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
});
afterEach(() => { vi.useRealTimers(); });

/** Runs `consumers` loops that each repeatedly take `piece` bytes, for `seconds` of fake time; returns bytes granted. */
async function runConsumers(budget: ReturnType<typeof createByteBudget>, consumers: number, piece: number, seconds: number): Promise<number> {
  let granted = 0;
  let running = true;
  const loops = Array.from({ length: consumers }, async () => {
    while (running) {
      await budget.take(piece).granted;
      granted += piece;
    }
  });
  for (let t = 0; t < seconds * 1000; t += 50) await vi.advanceTimersByTimeAsync(50);
  running = false;
  void loops;
  return granted;
}

describe('createByteBudget', () => {
  const RATE = 100_000; // capacity is a quarter second: 25,000

  it('gives a single consumer the whole budget', async () => {
    const granted = await runConsumers(createByteBudget(RATE), 1, 10_000, 2);
    expect(granted).toBeGreaterThanOrEqual(2 * RATE - 20_000);
    expect(granted).toBeLessThanOrEqual(2 * RATE + 25_000 + 10_000);
  });

  it('shares the same budget between many consumers, never exceeding it', async () => {
    const granted = await runConsumers(createByteBudget(RATE), 5, 10_000, 2);
    expect(granted).toBeGreaterThanOrEqual(2 * RATE - 20_000);
    expect(granted).toBeLessThanOrEqual(2 * RATE + 25_000 + 10_000);
  });

  it('serves waiters in the order they asked', async () => {
    const budget = createByteBudget(RATE);
    await budget.take(25_000).granted; // drains the bucket
    const order: number[] = [];
    [1, 2, 3].forEach((n) => { void budget.take(10_000).granted.then(() => { order.push(n); }); });
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual([1, 2, 3]);
  });

  it('a cancelled wait is never granted, uses no tokens and leaves nothing pending', async () => {
    const budget = createByteBudget(RATE);
    await budget.take(25_000).granted;
    const waiting = budget.take(10_000);
    let granted = false;
    void waiting.granted.then(() => { granted = true; });
    expect(budget.pending()).toBe(1);
    waiting.cancel();
    expect(budget.pending()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(granted).toBe(false);
    // The tokens refilled meanwhile are all still there for the next taker.
    await budget.take(25_000).granted;
  });

  it('stops its timer when nobody waits', async () => {
    const budget = createByteBudget(RATE);
    await budget.take(25_000).granted;
    void budget.take(10_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createThrottle', () => {
  /** Reads everything the throttle emits into `out`. */
  function collect(throttle: ReturnType<typeof createThrottle>, out: Buffer[]): void {
    throttle.on('data', (d: Buffer) => { out.push(d); });
  }

  it('passes data through in order, in slices no bigger than the slice size', async () => {
    const throttle = createThrottle(createByteBudget(10_000_000));
    const out: Buffer[] = [];
    collect(throttle, out);
    const input = Buffer.alloc(PRELOAD_SLICE_BYTES * 2 + 100, 7);
    throttle.write(input);
    await vi.advanceTimersByTimeAsync(500);
    expect(out.every((b) => b.length <= PRELOAD_SLICE_BYTES)).toBe(true);
    expect(Buffer.concat(out).equals(input)).toBe(true);
  });

  it('is paced by the budget', async () => {
    const throttle = createThrottle(createByteBudget(PRELOAD_SLICE_BYTES * 4)); // capacity = one slice
    const out: Buffer[] = [];
    collect(throttle, out);
    throttle.write(Buffer.alloc(PRELOAD_SLICE_BYTES * 8));
    await vi.advanceTimersByTimeAsync(0);
    expect(out.length).toBeLessThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(Buffer.concat(out).length).toBeLessThanOrEqual(PRELOAD_SLICE_BYTES * 5 + PRELOAD_SLICE_BYTES);
    await vi.advanceTimersByTimeAsync(5000);
    expect(Buffer.concat(out).length).toBe(PRELOAD_SLICE_BYTES * 8);
  });

  it('gives up its wait for tokens when destroyed, so a client that left does not hold a share', async () => {
    const budget = createByteBudget(1000);
    const throttle = createThrottle(budget);
    collect(throttle, []);
    throttle.write(Buffer.alloc(PRELOAD_SLICE_BYTES * 3));
    await vi.advanceTimersByTimeAsync(0);
    expect(budget.pending()).toBe(1);
    throttle.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(budget.pending()).toBe(0);
  });
});
