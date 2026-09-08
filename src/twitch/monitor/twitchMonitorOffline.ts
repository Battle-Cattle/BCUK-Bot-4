import { createLogger } from '../../shared/logger';
import { getStreams } from '../twitchApi';

const log = createLogger('TwitchMonitor');
import { LiveState } from './twitchMonitorTypes';
import { deleteAnnouncement } from './twitchMonitorAnnouncements';
import { setTwitchChannelLive } from '../../shared/statusStore';

const OFFLINE_GRACE_MS = 5 * 60 * 1000;

/**
 * Cancels and clears any pending offline-grace timers for every `liveStates` entry
 * belonging to `loginKey` (e.g. because the streamer was confirmed live again).
 * @param liveStates Live-state map keyed by group-scoped state key.
 * @param loginKey Normalized Twitch login whose timers should be cancelled.
 */
export function cancelOfflineTimersForLogin(liveStates: Map<string, LiveState>, loginKey: string): void {
  for (const state of liveStates.values()) {
    if (state.login === loginKey && state.offlineTimer) {
      clearTimeout(state.offlineTimer);
      state.offlineTimer = null;
    }
  }
}

// Re-fetches from liveStates rather than using the closure value so the check
// reflects any concurrent modifications (e.g. the streamer came back online and
// pollStreams already updated state, or a manual DB change cleared the entry).
// teardown() clears all offlineTimers on restart, so this is not restart
// protection — it is a consistency guard. The finally block ensures
// offlineTimer is nulled on every exit path, including early returns and errors.
/**
 * Fires at the end of a streamer's offline grace period: re-checks Helix directly, and if
 * still offline, marks the channel offline and removes its live announcement.
 * @param liveStates Live-state map keyed by group-scoped state key.
 * @param loginToUserId Map of normalized login to Twitch user id.
 * @param stateKey Group-scoped state key for the entry that scheduled this check.
 * @param key Normalized Twitch login.
 * @param login Original (non-normalized) login, used only for log messages.
 * @returns Resolves once the check (and any resulting announcement cleanup) completes.
 */
export async function runOfflineCheck(
  liveStates: Map<string, LiveState>,
  loginToUserId: Map<string, string>,
  stateKey: string,
  key: string,
  login: string,
): Promise<void> {
  const currentState = liveStates.get(stateKey);
  if (!currentState) return;
  try {
    const userId = loginToUserId.get(key);
    if (!userId) return;
    const streams = await getStreams([userId]);
    const isLive = streams.some((s) => s.user_id === userId && s.type === 'live');
    if (!isLive) {
      setTwitchChannelLive(key, false);
      await deleteAnnouncement(liveStates, stateKey);
      log.info(`${login} confirmed offline — announcement removed`);
    }
  } finally {
    currentState.offlineTimer = null;
  }
}

/**
 * Starts the offline grace period for every `liveStates` entry belonging to `login`: after
 * {@link OFFLINE_GRACE_MS}, {@link runOfflineCheck} re-confirms the streamer is actually
 * offline before tearing down its announcement.
 * @param liveStates Live-state map keyed by group-scoped state key.
 * @param loginToUserId Map of normalized login to Twitch user id.
 * @param login Twitch login that went offline.
 * @returns Resolves once the grace-period timers have been (re)scheduled.
 */
export async function handleStreamOffline(
  liveStates: Map<string, LiveState>,
  loginToUserId: Map<string, string>,
  login: string,
): Promise<void> {
  const key = login.toLowerCase();
  // Collect all state entries for this login (one per group they belong to)
  const matchingEntries = Array.from(liveStates.entries()).filter(([, s]) => s.login === key);
  if (matchingEntries.length === 0) return;

  for (const [stateKey, state] of matchingEntries) {
    if (state.offlineTimer) clearTimeout(state.offlineTimer);
    state.offlineTimer = setTimeout(async () => {
      try {
        await runOfflineCheck(liveStates, loginToUserId, stateKey, key, login);
      } catch (err) {
        log.error(`Offline-check failed for ${key} (${stateKey}):`, err);
      }
    }, OFFLINE_GRACE_MS);
  }

  log.info(`${login} went offline — grace period started`);
}
