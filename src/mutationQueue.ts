/**
 * Creates a per-key serializing queue for async operations.
 *
 * Operations sharing the same key run sequentially; operations on different
 * keys are independent. A failure in one queued operation does not prevent
 * later operations on the same key from running.
 */
export function createMutationQueue<K = string>(): {
  run<T>(key: K, operation: () => Promise<T>): Promise<T>;
} {
  const queues = new Map<K, Promise<void>>();

  return {
    async run<T>(key: K, operation: () => Promise<T>): Promise<T> {
      const previous = queues.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queued = (async () => {
        try {
          await previous;
        } catch {
          // Ignore earlier failures so later operations still run.
        }
        await current;
      })().catch(() => {});
      queues.set(key, queued);

      try {
        await previous;
      } catch {
        // Ignore earlier failures so later operations still run.
      }

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
