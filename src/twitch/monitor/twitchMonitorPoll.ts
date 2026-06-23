import { createLogger } from '../../shared/logger';
import { DbStreamerFull } from '../../db';
import { TwitchStream } from '../twitchApi';
import { LiveState } from './twitchMonitorTypes';
import { postAnnouncement, editAnnouncement } from './twitchMonitorAnnouncements';
import { cancelOfflineTimersForLogin, handleStreamOffline } from './twitchMonitorOffline';
import { setTwitchChannelLive } from '../../shared/statusStore';

const log = createLogger('TwitchMonitor');

// Per-login chain of pending operations — ensures the poll loop and EventSub-triggered
// immediate checks never call handlePollStreamer concurrently for the same login.
const loginQueues = new Map<string, Promise<void>>();

/**
 * Runs `fn` after any previously queued operation for `login` has settled, so callers
 * from different entrypoints (60s poll loop vs. triggerImmediateLiveCheck) never race on
 * the same login's liveStates entry. A failure in `fn` rejects the caller's promise but
 * does not block subsequent operations queued for the same login.
 */
export function withLoginLock<T>(login: string, fn: () => Promise<T>): Promise<T> {
  const previous = loginQueues.get(login) ?? Promise.resolve();
  const run = previous.then(() => fn());
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
}

/** Posts, edits, or no-ops the Discord announcement for a streamer who is currently live. */
async function handleLiveStreamer(params: LiveStreamerParams): Promise<void> {
  const { liveStates, streamer, loginKey, existing, pollStream } = params;
  const stateKey = String(streamer.id);
  const isNew = !liveStates.has(stateKey);
  if (isNew || (existing && !existing.messageId)) {
    // Went live, or state exists with no Discord message (e.g. Discord wasn't ready at startup)
    await postAnnouncement(liveStates, streamer, pollStream);
    if (isNew) log.info(`${loginKey} went live in group ${streamer.group.name}`);
  } else if (existing && existing.currentGame !== pollStream.game_name) {
    // Game changed
    await editAnnouncement(liveStates, existing, pollStream, 'new_game_message');
    log.info(`${loginKey} game changed to ${pollStream.game_name}`);
  } else if (existing && existing.title !== pollStream.title) {
    // Title-only change — refresh the existing post without re-announcing a game change
    await editAnnouncement(liveStates, existing, pollStream, 'live_message');
    log.info(`${loginKey} title changed`);
  } else if (existing) {
    // Still live, nothing changed — keep currentStream in sync (e.g. thumbnail refresh)
    existing.currentGame = pollStream.game_name;
    existing.title = pollStream.title;
    existing.currentStream = pollStream;
  }
}

/** Applies the live/offline/game/title transition for one streamer based on the latest poll result. */
export async function handlePollStreamer(
  liveStates: Map<string, LiveState>,
  loginToUserId: Map<string, string>,
  streamer: DbStreamerFull,
  liveByUserId: Map<string, TwitchStream>,
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
    await handleLiveStreamer({ liveStates, streamer, loginKey, existing, pollStream });
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
          await withLoginLock(loginKey, () => handlePollStreamer(liveStates, loginToUserId, streamer, liveByUserId));
        } catch (err) {
          log.error(`Error handling streamer poll for ${streamer.twitch_name ?? 'unknown'} in group ${streamer.group.name}:`, err);
        }
      }
    }),
  );
}
