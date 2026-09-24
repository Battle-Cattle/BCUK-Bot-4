import { createLogger } from '../../shared/logger';
import { DbStreamerFull } from '../../db';
import { TwitchStream } from '../twitchApi';
import { LiveState } from './twitchMonitorTypes';
import { postAnnouncement, editAnnouncement } from './twitchMonitorAnnouncements';
import { cancelOfflineTimersForLogin, handleStreamOffline } from './twitchMonitorOffline';
import { setTwitchChannelLive } from '../../shared/statusStore';
import { withLoginLock } from './twitchMonitorLoginLock';

const log = createLogger('TwitchMonitor');

// withLoginLock originated here but now lives in its own module (see twitchMonitorLoginLock.ts
// for the full rationale/doc) so twitchMonitorOffline.ts can also route its deferred
// offline-check callback through the same per-login lock. Re-exported so existing importers
// (twitchMonitor.ts, this file's tests) don't need to change their import path.
export { withLoginLock } from './twitchMonitorLoginLock';

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
    return;
  }
  if (!existing) return;

  if (existing.currentGame !== pollStream.game_name) {
    // Game changed
    await editAnnouncement(liveStates, existing, pollStream, 'new_game_message', isCurrent);
    if (!isCurrent()) return;
    log.info(`${loginKey} game changed to ${pollStream.game_name}`);
  } else if (existing.title !== pollStream.title) {
    // Title-only change — refresh the existing post without re-announcing a game change
    await editAnnouncement(liveStates, existing, pollStream, 'live_message', isCurrent);
    if (!isCurrent()) return;
    log.info(`${loginKey} title changed`);
  } else {
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
