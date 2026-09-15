import { withTimeout } from '../twitchSendQueue';

// Per-login chain of pending operations — ensures the poll loop, EventSub-triggered immediate
// checks, and offline-grace-period checks never run concurrently for the same login. Lives in
// its own module (rather than twitchMonitorPoll.ts, where it originated) so twitchMonitorOffline.ts
// can also route its deferred offline-check callback through the same lock without creating a
// twitchMonitorPoll.ts <-> twitchMonitorOffline.ts import cycle (twitchMonitorPoll.ts already
// imports from twitchMonitorOffline.ts).
const loginQueues = new Map<string, Promise<void>>();

// The generation number of the most recently *started* operation for each login — bumped right
// before `fn` runs, i.e. exactly when a new operation takes over the login's queue (whether the
// previous one finished normally or timed out). Lets a timed-out `fn` that's still running in the
// background (see LOGIN_LOCK_TIMEOUT_MS) recognize it's been superseded and stop short of any
// further state mutation or Discord call once it notices — see {@link withLoginLock}'s `isCurrent`.
const loginGenerations = new Map<string, number>();

/**
 * `fn` ultimately calls into discord.js `send`/`edit`/`fetch` (via postAnnouncement/
 * editAnnouncement/handleStreamOffline/runOfflineCheck), none of which have an explicit timeout
 * configured in this codebase. Since those calls run behind {@link loginQueues}, a stalled one
 * would otherwise wedge every later poll, immediate-check, and offline-check for that login
 * forever. Bounding the whole queued operation guarantees the queue always frees up, even though
 * the underlying call may still be stuck.
 */
const LOGIN_LOCK_TIMEOUT_MS = 20_000;

/**
 * Runs `fn` after any previously queued operation for `login` has settled, so callers
 * from different entrypoints (60s poll loop, triggerImmediateLiveCheck, and the deferred
 * offline-grace-period check) never race on the same login's liveStates entry. `fn` is bounded
 * by {@link LOGIN_LOCK_TIMEOUT_MS} so a stalled Discord call inside it can't wedge the queue for
 * this login forever. A failure in `fn` (including a timeout) rejects the caller's promise but
 * does not block subsequent operations queued for the same login.
 *
 * A timeout only stops *waiting* on `fn` — it does not cancel it, so `fn` may still be running
 * when the queue moves on to a later operation for the same login. `fn` receives an `isCurrent`
 * check (backed by {@link loginGenerations}) it must call before performing any further state
 * mutation or Discord call after an `await`, so a stale resumption notices it's been superseded
 * and stops instead of racing the newer operation.
 * @param login - The (already-lowercased) Twitch login whose queue `fn` should run behind.
 * @param fn - The operation to run once queued and any previous same-login operation has settled.
 *   Receives `isCurrent`, which returns false once a later operation for the same login has
 *   started (including one that started because this call's own timeout freed the queue).
 * @returns Resolves/rejects with `fn`'s own result, or rejects with a timeout error if `fn`
 *   doesn't settle within {@link LOGIN_LOCK_TIMEOUT_MS}.
 */
export function withLoginLock<T>(login: string, fn: (isCurrent: () => boolean) => Promise<T>): Promise<T> {
  const previous = loginQueues.get(login) ?? Promise.resolve();
  // Chains this call's timeout-bounded run onto `previous`; both branches resolve so a failure
  // here never poisons the chain for later same-login calls (mirrors mutationQueue's `release()`).
  const run = previous.then(() => {
    // Bumped here, not at withLoginLock() call time, so `isCurrent` stays true for this op's
    // entire run — a concurrently *enqueued* call isn't "newer" until it actually gets its turn.
    const generation = (loginGenerations.get(login) ?? 0) + 1;
    loginGenerations.set(login, generation);
    /** Returns whether this call is still the newest operation started for `login`. */
    const isCurrent = () => loginGenerations.get(login) === generation;
    return withTimeout(fn(isCurrent), LOGIN_LOCK_TIMEOUT_MS, `Login lock (${login})`);
  });
  loginQueues.set(login, run.then(() => undefined, () => undefined));
  return run;
}
