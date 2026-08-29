/**
 * Races `promise` against a `ms`-millisecond timeout, rejecting with a timeout error if it
 * doesn't settle in time. `promise` itself is left running — its eventual settlement is still
 * observed (and silently ignored) so it can never surface as an unhandled rejection later.
 * @param promise - The promise to bound.
 * @param ms - Milliseconds to wait before rejecting with a timeout error.
 * @param label - Describes what timed out, used in the rejection message (e.g. `'Twitch send'`).
 * @returns `promise`'s resolved value if it settles first; otherwise rejects with `promise`'s
 *   own rejection reason, or a timeout error if neither happens within `ms`.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    // Always cleared by promise settling above, but unref so a long-lived `ms` can't keep the
    // event loop alive on its own if the process would otherwise be idle.
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
