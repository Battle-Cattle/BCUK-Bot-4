import { Transform, type TransformCallback } from 'stream';

// A shared byte budget for the background preloads of the shared video overlay (#917): every
// preload response draws from one bucket, so more overlays syncing at once means each gets slower
// and the total never exceeds the configured rate.

/** How often waiting requests are checked against newly refilled tokens. */
const TICK_MS = 50;

/** Largest piece of a chunk asked for at once, so one response cannot hold the bucket for long. */
export const PRELOAD_SLICE_BYTES = 16 * 1024;

interface Waiter {
  bytes: number;
  grant: () => void;
}

/** A byte budget that hands out tokens first come, first served. */
export interface ByteBudget {
  /**
   * Waits for `bytes` tokens.
   * @param bytes - How many bytes the caller wants to send (at most the bucket capacity).
   * @returns The waiting promise, and a function that cancels the wait (the promise then never
   *   resolves, and no tokens are used).
   */
  take(bytes: number): { granted: Promise<void>; cancel: () => void };
  /** Number of requests waiting for tokens. Exposed for tests. */
  pending(): number;
}

/**
 * Creates a token bucket refilling at `bytesPerSecond`. Its capacity is a quarter second of
 * traffic (and never less than {@link PRELOAD_SLICE_BYTES}), which bounds any burst. A timer runs
 * only while somebody waits, and is unref'd so it never keeps the process alive.
 * @param bytesPerSecond - The combined rate every user of the budget may send at.
 * @returns The budget.
 */
export function createByteBudget(bytesPerSecond: number): ByteBudget {
  const capacity = Math.max(PRELOAD_SLICE_BYTES, Math.floor(bytesPerSecond / 4));
  let tokens = capacity;
  let lastRefill = Date.now();
  const queue: Waiter[] = [];
  let timer: NodeJS.Timeout | null = null;

  /** Adds the tokens earned since the last refill, up to the capacity (a clock stepped back earns none and costs none). */
  const refill = (): void => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + (Math.max(0, now - lastRefill) / 1000) * bytesPerSecond);
    lastRefill = now;
  };

  /** Grants waiting requests in order while there are tokens, stopping the timer once none wait. */
  const serve = (): void => {
    refill();
    while (queue[0] && tokens >= queue[0].bytes) {
      const waiter = queue.shift()!; // queue[0] checked just above
      tokens -= waiter.bytes;
      waiter.grant();
    }
    if (queue.length === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    take(bytes) {
      let grant = (): void => {};
      const granted = new Promise<void>((resolve) => { grant = resolve; });
      const waiter: Waiter = { bytes: Math.min(bytes, capacity), grant };
      queue.push(waiter);
      serve();
      if (queue.length > 0 && !timer) {
        timer = setInterval(serve, TICK_MS);
        timer.unref();
      }
      return {
        granted,
        cancel: () => {
          const i = queue.indexOf(waiter);
          if (i !== -1) queue.splice(i, 1);
          if (queue.length === 0 && timer) {
            clearInterval(timer);
            timer = null;
          }
        },
      };
    },
    pending: () => queue.length,
  };
}

/**
 * Creates a stream that passes data through at the pace the budget allows, in slices of at most
 * {@link PRELOAD_SLICE_BYTES}. Destroying it (a client that went away) cancels its wait for tokens
 * without using any.
 * @param budget - The shared budget to draw from.
 * @returns The throttling transform.
 */
export function createThrottle(budget: ByteBudget): Transform {
  let cancelWait: (() => void) | null = null;

  /**
   * Pushes one chunk downstream slice by slice, each once the budget grants its bytes.
   * @param chunk - The data read from the file.
   * @returns Resolves once every slice has been pushed.
   */
  async function pushSlices(chunk: Buffer): Promise<void> {
    for (let offset = 0; offset < chunk.length; offset += PRELOAD_SLICE_BYTES) {
      const slice = chunk.subarray(offset, offset + PRELOAD_SLICE_BYTES);
      const wait = budget.take(slice.length);
      cancelWait = wait.cancel;
      await wait.granted;
      cancelWait = null;
      // Destroyed while the grant was on its way: stop here, so no budget is drawn for data that
      // will never be sent.
      if (throttle.destroyed) return;
      throttle.push(slice);
    }
  }

  const throttle: Transform = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      pushSlices(chunk).then(() => { callback(); }, (err: unknown) => { callback(err as Error); });
    },
    destroy(err, callback) {
      cancelWait?.();
      callback(err);
    },
  });
  return throttle;
}
