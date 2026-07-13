/** Minimal contract every Twitch command runtime must satisfy: a function to send a chat message to a channel. */
export interface TwitchSendRuntime {
  send: (channel: string, message: string) => Promise<void>;
}

/**
 * Runtime contract for handlers that broadcast to multiple channels and need to
 * de-duplicate by Twitch shared-chat session — shared by `customCommandHandler.ts`
 * and `multiCommandHandler.ts` to avoid two copies of the same interface.
 */
export interface TwitchBroadcastRuntime extends TwitchSendRuntime {
  getActiveChannels: () => ReadonlySet<string>;
  getLoginUserIds: () => ReadonlyMap<string, string>;
}

/**
 * Creates a private module-level singleton slot for an injected runtime of type
 * `T`, along with `register`/`get` accessors. Factors out the
 * `let _runtime: T | null = null; registerXRuntime(); getXRuntime()` boilerplate
 * that command handlers (countdown, counter, shoutout, custom command,
 * multi-command) and other runtime-injection sites (EventSub overlay/companion/chat
 * push, reward pricing) previously duplicated for their own runtime shape — any
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
