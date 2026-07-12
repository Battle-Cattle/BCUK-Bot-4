/** Minimal contract every Twitch command runtime must satisfy: a function to send a chat message to a channel. */
export interface TwitchSendRuntime {
  send: (channel: string, message: string) => Promise<void>;
}

/**
 * Creates a private module-level singleton slot for a Twitch command runtime of
 * type `T`, along with `register`/`get` accessors. Factors out the
 * `let _runtime: T | null = null; registerXRuntime(); getXRuntime()` boilerplate
 * that each command handler (countdown, counter, shoutout, custom command,
 * multi-command) previously duplicated for its own runtime shape — handlers with
 * extra fields (e.g. `getActiveChannels`/`getLoginUserIds`) just parameterize `T`
 * with their richer interface.
 *
 * @returns `register(runtime)` to store the runtime, and `get()` to retrieve the
 *   currently registered runtime, or null if none has been registered yet.
 */
export function createRuntimeRegistry<T extends TwitchSendRuntime>(): {
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
