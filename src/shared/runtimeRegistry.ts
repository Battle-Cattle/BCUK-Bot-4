// Dependency-injection slot used wherever a module needs a platform client that is only
// available after startup (see "New Command Handler Pattern" in CLAUDE.md) without
// importing `src/index.ts` or the platform bootstrap and creating an import cycle.

/**
 * Creates a private module-level singleton slot for an injected runtime of type
 * `T`, along with `register`/`get` accessors. Factors out the
 * `let _runtime: T | null = null; registerXRuntime(); getXRuntime()` boilerplate
 * that command handlers (countdown, counter, shoutout, custom command,
 * multi-command) and other runtime-injection sites (EventSub overlay/companion/chat
 * push, reward pricing, timers, owner alerts, guild resolution) previously duplicated for their own runtime shape — any
 * plain runtime interface can parameterize `T`, not just ones with a `send` method.
 *
 * @returns `register(runtime)` to store the runtime, and `get()` to retrieve the
 *   currently registered runtime, or null if none has been registered yet.
 */
export function createRuntimeRegistry<T>(): {
  register: (runtime: T) => void;
  get: () => T | null;
} {
  let runtime: T | null = null;
  return {
    /** Stores `runtime` as the current singleton, replacing any previously-registered one. */
    register: (r: T): void => {
      runtime = r;
    },
    /** Returns the currently-registered runtime, or null if none has been registered yet. */
    get: (): T | null => runtime,
  };
}
