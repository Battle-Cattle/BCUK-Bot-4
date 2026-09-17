/** A single waiter's reservation for one key in a {@link createMutationQueue} queue. */
interface KeyAcquisition {
  /** Resolves once it's this waiter's turn. */
  turn: Promise<void>;
  /** Hands the slot to the next waiter — call it once, only after `turn` has resolved. */
  release: () => void;
  /**
   * Gives up this acquisition. If `turn` hasn't resolved yet, the slot is silently passed to the
   * next waiter as soon as it would otherwise have become ours. If `turn` has already resolved,
   * `release` is called immediately (idempotently) instead — needed because a later key in a
   * sorted set can become free, and its `turn` resolve, before an earlier key that's still
   * blocked is even settled; nothing else will ever call `release` for it in that case. Callers
   * that already have their own `release` reference for a still-in-use key (e.g. `runMany` after
   * successfully acquiring it) may still call `cancel` freely — `release` is idempotent.
   */
  cancel: () => void;
}

/**
 * Registers a waiter for `key`'s slot in `queues`. Queuing happens synchronously (recording
 * `key`'s new tail promise before returning), so several calls made back-to-back with no `await`
 * in between — as `runMany` does for its whole key set — reserve their slots as one atomic step
 * with no other caller able to interleave between them.
 * @param queues - The shared per-key tail-promise map for one {@link createMutationQueue} instance.
 * @param key - The key whose queue slot to wait for.
 * @returns This waiter's {@link KeyAcquisition}.
 */
function acquireKey<K>(queues: Map<K, Promise<void>>, key: K): KeyAcquisition {
  const previous = queues.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  // `previous` can never reject (see createMutationQueue's `run` doc comment), so `queued` is
  // awaited by later callers instead of `current` alone, with no try/catch needed to swallow a
  // failure that can't structurally occur.
  const queued = (async () => {
    await previous;
    await current;
  })().catch(() => {});
  queues.set(key, queued);

  let settled = false;
  const release = (): void => {
    if (settled) return;
    settled = true;
    releaseCurrent();
    if (queues.get(key) === queued) {
      queues.delete(key);
    }
  };

  let cancelled = false;
  let turnArrived = false;
  void previous.then(() => {
    turnArrived = true;
    if (cancelled) {
      release();
    }
  });

  return {
    turn: previous,
    release,
    cancel: () => {
      cancelled = true;
      if (turnArrived) {
        release();
      }
    },
  };
}

/** A shared deadline for a bounded call, exposed as a promise so it can be raced against. */
interface Deadline {
  /** Resolves once `timeoutMs` has elapsed. */
  promise: Promise<void>;
  /** The underlying timer, for clearing once the bounded call no longer needs it. */
  timer: ReturnType<typeof setTimeout>;
  /** True once `promise` has resolved. */
  timedOut: () => boolean;
}

/**
 * Starts a `timeoutMs` timer and exposes it as a racable {@link Deadline}.
 * @param timeoutMs - Milliseconds until the deadline is reached.
 * @returns The deadline; its timer is unref'd so a long-lived `timeoutMs` can't keep the event
 *   loop alive on its own.
 */
function createDeadline(timeoutMs: number): Deadline {
  let timedOut = false;
  let timer!: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
    timer.unref();
  });
  return { promise, timer, timedOut: () => timedOut };
}

/**
 * Atomically reserves every key in `keys` (deduplicated, in a fixed sorted order so two calls
 * naming an overlapping key set never wait on each other's slot and deadlock) and waits for all
 * of them to become free, bounded by `deadline`.
 * @param queues - The shared per-key tail-promise map for one {@link createMutationQueue} instance.
 * @param keys - The keys to acquire together; duplicates collapse to one slot.
 * @param deadline - The shared deadline bounding the wait for every key.
 * @param timeoutMs - The deadline's original duration, used only in the timeout error message.
 * @param label - Describes what timed out, used in the rejection message.
 * @returns The `release` function for each acquired key, in acquisition order.
 * @throws If `deadline` is reached before every key is acquired — every reservation is abandoned
 *   first (a key already held is released immediately; a key whose turn hasn't arrived yet is
 *   cancelled so it's silently passed to the next waiter instead of held hostage).
 */
async function acquireAll<K>(
  queues: Map<K, Promise<void>>,
  keys: K[],
  deadline: Deadline,
  timeoutMs: number,
  label: string,
): Promise<Array<() => void>> {
  const acquisitions = [...new Set(keys)].sort().map((key) => acquireKey(queues, key));
  const held: Array<() => void> = [];

  for (const acquisition of acquisitions) {
    await Promise.race([acquisition.turn, deadline.promise]);
    if (deadline.timedOut()) {
      for (const other of acquisitions) other.cancel();
      for (const release of held) release();
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    held.push(acquisition.release);
  }

  return held;
}

/**
 * Runs `operation` with every key in `held` already acquired, releasing all of them once
 * `operation` settles. Bounds only what the *caller* observes to `deadline`: if `operation` is
 * still running when `deadline` is reached, it is left running and every key stays held until it
 * genuinely settles, so it can never race a later mutation for any of those keys.
 * @param operation - The async work to run with every key held.
 * @param held - The `release` function for each key to release once `operation` settles.
 * @param deadline - The shared deadline bounding what the caller waits for.
 * @param timeoutMs - The deadline's original duration, used only in the timeout error message.
 * @param label - Describes what timed out, used in the rejection message.
 * @returns Resolves or rejects with `operation`'s own result, or rejects with a timeout error if
 *   `deadline` is reached first (`operation` keeps running and releases `held` once it settles).
 */
function runWithHeldKeys<T>(
  operation: () => Promise<T>,
  held: Array<() => void>,
  deadline: Deadline,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    void deadline.promise.then(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    });
    void (async () => {
      try {
        const result = await operation();
        clearTimeout(deadline.timer);
        for (const release of held) release();
        resolve(result);
      } catch (err) {
        clearTimeout(deadline.timer);
        for (const release of held) release();
        reject(err as Error);
      }
    })();
  });
}

/**
 * Creates a per-key serializing queue for async operations, with support for atomically
 * acquiring and holding several keys at once for a single operation.
 *
 * Operations sharing the same key run sequentially; operations on different
 * keys are independent. A failure in one queued operation does not prevent
 * later operations on the same key from running.
 */
export function createMutationQueue<K extends string = string>(): {
  /**
   * Runs `operation` once any previously queued operation for `key` has settled. Two hazards
   * to avoid when writing `operation`, both of which hang this key's queue forever with no
   * error and nothing to log:
   * - `operation` has no built-in timeout — if it awaits something that can stall indefinitely
   *   (e.g. a network call with no timeout of its own), bound it yourself. See `withTimeout` in
   *   `src/twitch/twitchSendQueue.ts` for the established pattern, reused by
   *   `twitchChannelMembership.ts` and `twitchMonitorPoll.ts`.
   * - `operation` must never call `run()` again for this same `key` and await the result — that
   *   inner call queues behind the outer one, which is itself waiting on the inner call: a
   *   circular wait that never resolves.
   * @param key - Operations sharing a key are serialized; operations on different keys run
   *   independently.
   * @param operation - The async work to run once queued.
   * @returns Resolves or rejects with `operation`'s own result.
   */
  run<T>(key: K, operation: () => Promise<T>): Promise<T>;
  /**
   * Atomically reserves every key in `keys` (deduplicated, in a fixed sorted order so two calls
   * naming an overlapping key set never wait on each other's slot and deadlock), waits for all of
   * them to become free, then runs `operation` with all of them held. The whole call — waiting for
   * every key plus `operation` itself — is bounded by `timeoutMs`: if that elapses before every key
   * has been acquired, every reservation is abandoned (a key already held is released immediately;
   * a key whose turn hasn't arrived yet is cancelled so it's silently passed to the next waiter
   * instead of held hostage) and the returned promise rejects. If `operation` itself is still
   * running when `timeoutMs` elapses, it is left running — mirroring `run`'s own single-key
   * timeout tradeoff — so every held key stays held until `operation` genuinely settles and can
   * never race a later mutation for any of those keys.
   * @param keys - The keys to acquire together; duplicates collapse to one slot.
   * @param operation - The async work to run once every key is held.
   * @param timeoutMs - Milliseconds allowed for the whole call (acquiring every key plus running
   *   `operation`) before the caller sees a timeout rejection.
   * @param label - Describes what timed out, used in the rejection message (e.g. `'User mutation'`).
   * @returns Resolves or rejects with `operation`'s own result, or rejects with a timeout error if
   *   the deadline occurs before every key is acquired or `operation` settles.
   */
  runMany<T>(keys: K[], operation: () => Promise<T>, timeoutMs: number, label: string): Promise<T>;
  /** Number of keys with at least one operation in flight. */
  size(): number;
} {
  const queues = new Map<K, Promise<void>>();

  return {
    size: () => queues.size,
    async run<T>(key: K, operation: () => Promise<T>): Promise<T> {
      const { turn, release } = acquireKey(queues, key);
      await turn;

      try {
        return await operation();
      } finally {
        release();
      }
    },
    async runMany<T>(keys: K[], operation: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
      const deadline = createDeadline(timeoutMs);
      const held = await acquireAll(queues, keys, deadline, timeoutMs, label);
      return runWithHeldKeys(operation, held, deadline, timeoutMs, label);
    },
  };
}
