/**
 * Creates a per-key serializing queue for async operations.
 *
 * Operations sharing the same key run sequentially; operations on different
 * keys are independent. A failure in one queued operation does not prevent
 * later operations on the same key from running.
 */
export function createMutationQueue<K = string>(): {
  run<T>(key: K, operation: () => Promise<T>): Promise<T>;
  /** Number of keys with at least one operation in flight. */
  size(): number;
} {
  const queues = new Map<K, Promise<void>>();

  return {
    size: () => queues.size,
    async run<T>(key: K, operation: () => Promise<T>): Promise<T> {
      const previous = queues.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      // `previous` can never reject: it's either `Promise.resolve()` (first
      // call for this key) or a prior call's `queued` value, which is always
      // wrapped in `.catch(() => {})` below before being stored. So both the
      // externally-visible chain and this call's own execution gate can await
      // it directly — no try/catch needed to swallow a failure that can't
      // structurally occur, and no shared derived promise is introduced
      // (which would add a microtask tick relative to awaiting `previous`
      // itself, shifting when downstream operations observably start).
      const queued = (async () => {
        await previous;
        await current;
      })().catch(() => {});
      queues.set(key, queued);

      await previous;

      try {
        return await operation();
      } finally {
        release();
        if (queues.get(key) === queued) {
          queues.delete(key);
        }
      }
    },
  };
}
