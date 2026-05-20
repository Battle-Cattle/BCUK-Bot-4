import { createLogger } from './logger';
import { getStreams } from './twitchApi';

const log = createLogger('TwitchMonitor');
import { LiveState } from './twitchMonitorTypes';
import { deleteAnnouncement } from './twitchMonitorAnnouncements';

const OFFLINE_GRACE_MS = 5 * 60 * 1000;

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
      await deleteAnnouncement(liveStates, stateKey);
      log.info(`${login} confirmed offline — announcement removed`);
    }
  } finally {
    currentState.offlineTimer = null;
  }
}

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
