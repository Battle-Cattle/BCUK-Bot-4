/**
 * Creates a per-key serializing queue for async operations, with support for atomically
 * acquiring and holding several keys at once for a single operation.
 *
 * Operations sharing the same key run sequentially; operations on different
 * keys are independent. A failure in one queued operation does not prevent
 * later operations on the same key from running.
 */
export function createMutationQueue<K = string>(): {
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
   *   every key isn't acquired and `operation` settled within `timeoutMs`.
   */
  runMany<T>(keys: K[], operation: () => Promise<T>, timeoutMs: number, label: string): Promise<T>;
  /** Number of keys with at least one operation in flight. */
  size(): number;
} {
  const queues = new Map<K, Promise<void>>();

  /**
   * Registers a waiter for `key`'s queue slot. Queuing happens synchronously (recording `key`'s
   * new tail promise before returning), so several calls made back-to-back with no `await` in
   * between — as `runMany` does for its whole key set — reserve their slots as one atomic step
   * with no other caller able to interleave between them.
   * @param key - The key whose queue slot to wait for.
   * @returns `turn` resolves once it's this waiter's turn. `release` hands the slot to the next
   *   waiter — call it once, only after `turn` has resolved. `cancel` gives up this waiter's turn
   *   if it hasn't arrived yet, silently passing the slot to the next waiter as soon as it would
   *   otherwise have become ours; once `turn` has already resolved, `cancel` is a no-op — an
   *   already-active waiter's key is never released early by a stray `cancel` call.
   */
  function acquire(key: K): { turn: Promise<void>; release: () => void; cancel: () => void } {
    const previous = queues.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    // See createMutationQueue's own `run` doc comment for why `previous` can never reject and
    // why `queued` is awaited by later callers instead of `current` alone.
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
    void previous.then(() => {
      if (cancelled) {
        release();
      }
    });

    return {
      turn: previous,
      release,
      cancel: () => {
        cancelled = true;
      },
    };
  }

  return {
    size: () => queues.size,
    async run<T>(key: K, operation: () => Promise<T>): Promise<T> {
      const { turn, release } = acquire(key);
      await turn;

      try {
        return await operation();
      } finally {
        release();
      }
    },
    async runMany<T>(keys: K[], operation: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
      const uniqueKeys = [...new Set(keys)].sort();
      const acquisitions = uniqueKeys.map((key) => acquire(key));
      const held: Array<() => void> = [];

      let timedOut = false;
      let timer!: ReturnType<typeof setTimeout>;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
        // Unref'd so a long-lived `timeoutMs` can't keep the event loop alive on its own; cleared
        // once `operation` settles below, whichever comes first.
        timer.unref();
      });

      for (const acquisition of acquisitions) {
        await Promise.race([acquisition.turn, deadline]);
        if (timedOut) {
          // Give up every reservation, not just the one we were waiting on: any not yet reached
          // in this loop still hold a reserved slot in their key's queue. Ones already held are
          // released for real; the rest just pass their turn on once it arrives, per `acquire`.
          for (const other of acquisitions) other.cancel();
          for (const release of held) release();
          throw new Error(`${label} timed out after ${timeoutMs}ms`);
        }
        held.push(acquisition.release);
      }

      return new Promise<T>((resolve, reject) => {
        void deadline.then(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        });
        void (async () => {
          try {
            const result = await operation();
            clearTimeout(timer);
            for (const release of held) release();
            resolve(result);
          } catch (err) {
            clearTimeout(timer);
            for (const release of held) release();
            reject(err as Error);
          }
        })();
      });
    },
  };
}
