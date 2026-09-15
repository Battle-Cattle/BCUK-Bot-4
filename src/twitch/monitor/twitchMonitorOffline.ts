import { createLogger } from '../../shared/logger';
import { getStreams } from '../twitchApi';

const log = createLogger('TwitchMonitor');
import { LiveState } from './twitchMonitorTypes';
import { deleteAnnouncement } from './twitchMonitorAnnouncements';
import { setTwitchChannelLive } from '../../shared/statusStore';
import { withLoginLock } from './twitchMonitorLoginLock';

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
//
// Routed through withLoginLock (same lock the poll loop and triggerImmediateLiveCheck use) so
// this deferred check can't race a concurrent poll/immediate-check for the same login: without
// it, a stream that flaps offline-then-online right at grace-period expiry could have this
// check's own (now-stale) "still offline" Helix result delete an announcement a concurrent,
// lock-protected poll had just confirmed/updated as live. `isCurrent()` is re-checked after the
// Helix call for the same reason `handlePollStreamer`/`postAnnouncement`/`editAnnouncement` do —
// see withLoginLock's doc comment.
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
  await withLoginLock(key, async (isCurrent) => {
    const currentState = liveStates.get(stateKey);
    if (!currentState) return;
    // Captured before any await, so the `finally` below only ever clears the specific timer
    // this call owns — not a newer timer a superseding same-login operation may have since
    // scheduled on this same LiveState object (e.g. a fresh handleStreamOffline() call after a
    // flap back offline).
    const ownedTimer = currentState.offlineTimer;
    try {
      const userId = loginToUserId.get(key);
      if (!userId) return;
      const streams = await getStreams([userId]);
      if (!isCurrent()) return; // superseded while awaiting — a newer op already owns this login's state
      const isLive = streams.some((s) => s.user_id === userId && s.type === 'live');
      if (!isLive) {
        setTwitchChannelLive(key, false);
        // isCurrent is passed through so a caller superseded mid-delete (e.g. this lock timed
        // out and a newer poll re-confirmed the streamer live while Discord/DB calls were still
        // in flight) stops before clearing state the newer operation now owns — see
        // deleteAnnouncement's own doc comment.
        await deleteAnnouncement(liveStates, stateKey, isCurrent);
        if (isCurrent()) log.info(`${login} confirmed offline — announcement removed`);
      }
    } finally {
      if (currentState.offlineTimer === ownedTimer) currentState.offlineTimer = null;
    }
  });
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
