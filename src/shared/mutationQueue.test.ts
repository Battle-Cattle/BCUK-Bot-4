import { describe, it, expect } from 'vitest';
import { createMutationQueue } from './mutationQueue';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createMutationQueue', () => {
  // ─── Invariant 1: same-key serialization ──────────────────────────────────

  it('runs same-key operations sequentially in enqueue order', async () => {
    const queue = createMutationQueue();
    const order: string[] = [];
    const { promise: gate, resolve: openGate } = deferred();

    // op1 holds the gate open so op2 cannot start until op1 finishes
    const op1 = queue.run('k', async () => {
      order.push('a-start');
      await gate;
      order.push('a-end');
    });
    const op2 = queue.run('k', async () => {
      order.push('b-start');
      order.push('b-end');
    });

    openGate();
    await Promise.all([op1, op2]);

    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  // ─── Invariant 2: different-key independence ───────────────────────────────

  it('allows concurrent execution across different keys', async () => {
    const queue = createMutationQueue();
    const { promise: gate, resolve: openGate } = deferred();
    const order: string[] = [];

    // opA blocks on the gate; if keys were serialized globally this would deadlock
    const opA = queue.run('a', async () => {
      await gate;
      order.push('a');
    });

    // Awaiting opB must complete while opA is still blocked — proves independence
    await queue.run('b', async () => { order.push('b'); });
    expect(order).toEqual(['b']);

    openGate();
    await opA;
    expect(order).toEqual(['b', 'a']);
  });

  // ─── Invariant 3: failure isolation ───────────────────────────────────────

  it('does not block subsequent same-key operations when a previous one fails', async () => {
    const queue = createMutationQueue();
    const order: string[] = [];

    // Enqueue both before either runs so op2 genuinely chains off a failing op1
    const op1 = queue.run('k', async () => { throw new Error('boom'); });
    const op2 = queue.run('k', async () => { order.push('second'); });

    await expect(op1).rejects.toThrow('boom');
    await op2;
    expect(order).toEqual(['second']);
  });

  // ─── Queue-map cleanup ────────────────────────────────────────────────────

  it('removes the key from the internal map after the last operation completes', async () => {
    const queue = createMutationQueue();

    expect(queue.size()).toBe(0);

    const { promise: gate, resolve: openGate } = deferred();
    const inflight = queue.run('k', async () => { await gate; });

    expect(queue.size()).toBe(1); // entry exists while operation is in flight

    openGate();
    await inflight;

    expect(queue.size()).toBe(0); // entry removed once queue drains
  });

  it('keeps the key present while a second operation is queued behind the first', async () => {
    const queue = createMutationQueue();
    const { promise: gate, resolve: openGate } = deferred();

    const op1 = queue.run('k', async () => { await gate; });
    const op2 = queue.run('k', async () => {});

    expect(queue.size()).toBe(1); // one entry covers both pending ops for 'k'

    openGate();
    await Promise.all([op1, op2]);

    expect(queue.size()).toBe(0);
  });
});
