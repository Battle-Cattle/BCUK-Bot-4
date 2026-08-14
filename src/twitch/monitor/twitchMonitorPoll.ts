import { createLogger } from '../../shared/logger';
import { DbStreamerFull } from '../../db';
import { TwitchStream } from '../twitchApi';
import { LiveState } from './twitchMonitorTypes';
import { postAnnouncement, editAnnouncement } from './twitchMonitorAnnouncements';
import { cancelOfflineTimersForLogin, handleStreamOffline } from './twitchMonitorOffline';
import { setTwitchChannelLive } from '../../shared/statusStore';
import { withTimeout } from '../twitchSendQueue';

const log = createLogger('TwitchMonitor');

// Per-login chain of pending operations — ensures the poll loop and EventSub-triggered
// immediate checks never call handlePollStreamer concurrently for the same login.
const loginQueues = new Map<string, Promise<void>>();

// The generation number of the most recently *started* operation for each login — bumped right
// before `fn` runs, i.e. exactly when a new operation takes over the login's queue (whether the
// previous one finished normally or timed out). Lets a timed-out `fn` that's still running in the
// background (see LOGIN_LOCK_TIMEOUT_MS) recognize it's been superseded and stop short of any
// further state mutation or Discord call once it notices — see {@link withLoginLock}'s `isCurrent`.
const loginGenerations = new Map<string, number>();

/**
 * `fn` ultimately calls into discord.js `send`/`edit`/`fetch` (via postAnnouncement/
 * editAnnouncement/handleStreamOffline), none of which have an explicit timeout configured in
 * this codebase. Since those calls run behind {@link loginQueues}, a stalled one would otherwise
 * wedge every later poll and immediate-check for that login forever. Bounding the whole queued
 * operation guarantees the queue always frees up, even though the underlying call may still be
 * stuck.
 */
const LOGIN_LOCK_TIMEOUT_MS = 20_000;

/**
 * Runs `fn` after any previously queued operation for `login` has settled, so callers
 * from different entrypoints (60s poll loop vs. triggerImmediateLiveCheck) never race on
 * the same login's liveStates entry. `fn` is bounded by {@link LOGIN_LOCK_TIMEOUT_MS} so a
 * stalled Discord call inside it can't wedge the queue for this login forever. A failure in
 * `fn` (including a timeout) rejects the caller's promise but does not block subsequent
 * operations queued for the same login.
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

/** Params bundle for {@link handleLiveStreamer} — groups the per-streamer poll context into a single argument. */
interface LiveStreamerParams {
  liveStates: Map<string, LiveState>;
  streamer: DbStreamerFull;
  loginKey: string;
  existing: LiveState | undefined;
  pollStream: TwitchStream;
  /** See {@link withLoginLock} — false once a newer operation has superseded this one. */
  isCurrent: () => boolean;
}

/**
 * Posts, edits, or no-ops the Discord announcement for a streamer who is currently live.
 * @param params - See {@link LiveStreamerParams}.
 * @returns Resolves once the announcement (if any) has been sent/edited, or once this call
 *   notices — after its own `await` — that it's been superseded and stops without acting further.
 */
async function handleLiveStreamer(params: LiveStreamerParams): Promise<void> {
  const { liveStates, streamer, loginKey, existing, pollStream, isCurrent } = params;
  const stateKey = String(streamer.id);
  const isNew = !liveStates.has(stateKey);
  if (isNew || (existing && !existing.messageId)) {
    // Went live, or state exists with no Discord message (e.g. Discord wasn't ready at startup)
    await postAnnouncement(liveStates, streamer, pollStream, isCurrent);
    if (!isCurrent()) return; // superseded while awaiting — a newer op already owns this login's state
    if (isNew) log.info(`${loginKey} went live in group ${streamer.group.name}`);
  } else if (existing && existing.currentGame !== pollStream.game_name) {
    // Game changed
    await editAnnouncement(liveStates, existing, pollStream, 'new_game_message', isCurrent);
    if (!isCurrent()) return;
    log.info(`${loginKey} game changed to ${pollStream.game_name}`);
  } else if (existing && existing.title !== pollStream.title) {
    // Title-only change — refresh the existing post without re-announcing a game change
    await editAnnouncement(liveStates, existing, pollStream, 'live_message', isCurrent);
    if (!isCurrent()) return;
    log.info(`${loginKey} title changed`);
  } else if (existing) {
    if (!isCurrent()) return;
    // Still live, nothing changed — keep currentStream in sync (e.g. thumbnail refresh)
    existing.currentGame = pollStream.game_name;
    existing.title = pollStream.title;
    existing.currentStream = pollStream;
  }
}

/**
 * Applies the live/offline/game/title transition for one streamer based on the latest poll result.
 * @param liveStates - Shared per-streamer live-state map, keyed by streamer ID.
 * @param loginToUserId - Resolved Twitch login → user ID map for the current poll batch.
 * @param streamer - The streamer row being processed.
 * @param liveByUserId - Currently-live streams from the poll, keyed by Twitch user ID.
 * @param isCurrent - See {@link withLoginLock}; checked after each `await` so a resumption that's
 *   been superseded by a newer same-login operation stops instead of racing it.
 * @returns Resolves once the transition (if any) has been applied, or once this call notices it's
 *   been superseded and stops.
 */
export async function handlePollStreamer(
  liveStates: Map<string, LiveState>,
  loginToUserId: Map<string, string>,
  streamer: DbStreamerFull,
  liveByUserId: Map<string, TwitchStream>,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const loginKey = streamer.twitch_name?.toLowerCase();
  if (!loginKey) return;
  const stateKey = String(streamer.id);
  const userId = loginToUserId.get(loginKey);
  if (!userId) return;

  const pollStream = liveByUserId.get(userId);
  const existing = liveStates.get(stateKey);

  if (pollStream) {
    if (existing?.offlineTimer) {
      // Came back during grace period — cancel offline timers for all groups this login belongs to
      cancelOfflineTimersForLogin(liveStates, loginKey);
      log.info(`${loginKey} came back — offline timer(s) cancelled`);
    }
    setTwitchChannelLive(loginKey, true);
    await handleLiveStreamer({ liveStates, streamer, loginKey, existing, pollStream, isCurrent });
  } else if (existing && !existing.offlineTimer) {
    // Appears offline — start grace period (handleStreamOffline handles all groups for this login)
    await handleStreamOffline(liveStates, loginToUserId, loginKey);
  }
}

/** Dispatches poll results to each streamer, serializing same-login rows (shared offline-timer state) and parallelizing across logins. */
export async function dispatchStreamerPolls(
  liveStates: Map<string, LiveState>,
  loginToUserId: Map<string, string>,
  streamers: DbStreamerFull[],
  liveByUserId: Map<string, TwitchStream>,
): Promise<void> {
  const byLogin = new Map<string, DbStreamerFull[]>();
  for (const streamer of streamers) {
    const key = streamer.twitch_name?.toLowerCase() ?? '';
    if (!key) continue;
    const existing = byLogin.get(key);
    if (existing) existing.push(streamer);
    else byLogin.set(key, [streamer]);
  }

  await Promise.allSettled(
    Array.from(byLogin.entries()).map(async ([loginKey, group]) => {
      for (const streamer of group) {
        try {
          await withLoginLock(loginKey, (isCurrent) => handlePollStreamer(liveStates, loginToUserId, streamer, liveByUserId, isCurrent));
        } catch (err) {
          log.error(`Error handling streamer poll for ${streamer.twitch_name ?? 'unknown'} in group ${streamer.group.name}:`, err);
        }
      }
    }),
  );
}
