import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  // ─── Timing: first call on a key starts promptly ──────────────────────────

  it('starts operation() for a fresh key within a single microtask tick', async () => {
    const queue = createMutationQueue();
    let started = false;

    // A fresh key has no `previous` to wait on (it defaults to an
    // already-resolved promise), so operation() must begin executing after
    // exactly one microtask tick. Any extra internal indirection between the
    // gate and `previous` (e.g. deriving a shared "settled" promise via
    // .then/.catch instead of awaiting `previous` directly) adds a tick here
    // and is an observable regression — real callers key their own timing
    // off exactly this.
    void queue.run('k', async () => { started = true; });

    await Promise.resolve();
    expect(started).toBe(true);
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

describe('createMutationQueue - runMany', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── (a) two operations sharing one key still serialize ───────────────────

  it('serializes operations that share a key, even when acquired via runMany', async () => {
    const queue = createMutationQueue();
    const order: string[] = [];
    const { promise: gate, resolve: openGate } = deferred();

    const op1 = queue.runMany(['k'], async () => {
      order.push('a-start');
      await gate;
      order.push('a-end');
    }, 1_000, 'test');
    const op2 = queue.runMany(['k'], async () => {
      order.push('b');
    }, 1_000, 'test');

    openGate();
    await Promise.all([op1, op2]);

    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('acquires every key before running the operation', async () => {
    const queue = createMutationQueue();
    const order: string[] = [];
    const { promise: gate, resolve: openGate } = deferred();

    const holder = queue.run('b', async () => { await gate; });
    const guarded = queue.runMany(['a', 'b'], async () => {
      order.push('operation');
    }, 1_000, 'test');

    await Promise.resolve();
    expect(order).toEqual([]); // 'b' is still held, so the operation can't have started

    openGate();
    await holder;
    await guarded;
    expect(order).toEqual(['operation']);
  });

  it('de-dupes a repeated key to a single slot instead of deadlocking against itself', async () => {
    const queue = createMutationQueue();
    const result = await queue.runMany(['k', 'k'], async () => 'ok', 1_000, 'test');
    expect(result).toBe('ok');
    expect(queue.size()).toBe(0);
  });

  // ─── (b) a timed-out pending acquisition doesn't block a later operation ──

  it('cancels a still-pending acquisition on timeout, releasing every key without abandoning any operation', async () => {
    const queue = createMutationQueue();

    // Hold 'b' so the guarded call below acquires 'a' immediately but stalls waiting on 'b'.
    let releaseB!: () => void;
    const holdB = queue.run('b', () => new Promise<void>((resolve) => { releaseB = resolve; }));

    const operation = vi.fn().mockResolvedValue('done');
    const guarded = queue.runMany(['a', 'b'], operation, 1_000, 'test');
    const assertion = expect(guarded).rejects.toThrow('test timed out after 1000ms');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(operation).not.toHaveBeenCalled();

    // 'a' was already acquired when the timeout hit — it must be released immediately rather
    // than held until 'b' (the key actually holding things up) eventually frees.
    expect(await queue.run('a', async () => 'a-free')).toBe('a-free');

    // Once 'b' frees for real, a fresh operation for it must not be blocked by the cancelled,
    // never-started guarded operation above.
    releaseB();
    await holdB;
    expect(await queue.run('b', async () => 'b-free')).toBe('b-free');
  });

  // Regression test: a later sorted key can become free (its `turn` resolving) before an
  // *earlier* key that's still blocked is even reached in the acquisition loop. Cancelling that
  // later key's acquisition on timeout must still release it — otherwise nothing else ever would,
  // since it was never added to `held` and its own `previous.then` callback already ran with
  // `cancelled` still false by the time the timeout calls `cancel()`.
  it('releases a later, already-free key on timeout even though its own turn arrived before it was ever reached', async () => {
    const queue = createMutationQueue();

    // Hold 'a' (sorts first) so the guarded call stalls on it, even though 'b' (sorts second)
    // is free the whole time and its acquisition's turn resolves almost immediately.
    let releaseA!: () => void;
    const holdA = queue.run('a', () => new Promise<void>((resolve) => { releaseA = resolve; }));

    const operation = vi.fn().mockResolvedValue('done');
    const guarded = queue.runMany(['a', 'b'], operation, 1_000, 'test');
    const assertion = expect(guarded).rejects.toThrow('test timed out after 1000ms');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(operation).not.toHaveBeenCalled();

    // 'b' must not be stuck forever just because its slot became free before the guarded call
    // ever got around to using it.
    expect(await queue.run('b', async () => 'b-free')).toBe('b-free');

    releaseA();
    await holdA;
  });

  // ─── (c) an already-running operation's key is never released early ──────

  it('keeps every key held until a stalled operation genuinely settles, past the timeout', async () => {
    const queue = createMutationQueue();
    let resolveOperation!: (value: string) => void;
    const guarded = queue.runMany(['x', 'y'], () => new Promise<string>((resolve) => { resolveOperation = resolve; }), 100, 'test');

    const assertion = expect(guarded).rejects.toThrow('test timed out after 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;

    // Both keys are still held by the still-running operation — queued mutations for either
    // must wait for it to genuinely finish, so they can never race its eventual side effects.
    const nextX = queue.run('x', async () => 'x-next');
    const nextY = queue.run('y', async () => 'y-next');
    await vi.advanceTimersByTimeAsync(10_000);
    const order: string[] = [];
    void nextX.then(() => order.push('x-next'));
    void nextY.then(() => order.push('y-next'));
    await Promise.resolve();
    expect(order).toEqual([]);

    resolveOperation('done');
    expect(await nextX).toBe('x-next');
    expect(await nextY).toBe('y-next');
  });
});
