// Cache of the timer scheduler's enabled rows, so a steady-state 15s tick makes no DB query.
// timerCommands.ts is a pure DB layer with no cache knowledge; timerCommandWrites.ts (timer
// writes) and userWrites.ts (Twitch name / bot-enabled writes the query also depends on)
// invalidate it.
import {
  createManagedLookupCache,
  type RefreshingLookupCache,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
} from './lookupCache';
import { getAllEnabledTimerCommandsWithChannel, type TimerCommandForScheduler } from './timerCommands';

// ─── Cache interface ──────────────────────────────────────────────────────────

interface TimerCommandSchedulerCache extends RefreshingLookupCache {
  /** The scheduler rows, or null for the fallback installed after a failed first load. */
  rows: TimerCommandForScheduler[] | null;
}

// ─── Cache state ──────────────────────────────────────────────────────────────

const timerCommandCacheState = createManagedLookupCache<TimerCommandSchedulerCache>({
  cacheName: 'timer command cache',
  // The TTL is a safety net on top of invalidation: a write that bypasses the wrappers (e.g. a
  // manual SQL fix) is picked up within this window.
  ttlMs: DEFAULT_CACHE_TTL_MS,
  refreshFailureBackoffMs: DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  // Null rather than [] so a failed first load surfaces as an error to the scheduler instead of
  // looking like "no timers", which would prune every timer's in-memory firing state.
  createEmptyCache: () => ({ loadedAt: 0, rows: null }),
  loadCache: async () => ({ loadedAt: Date.now(), rows: await getAllEnabledTimerCommandsWithChannel() }),
});

// ─── Public API ───────────────────────────────────────────────────────────────

/** Marks the timer command cache as stale so the next scheduler read reloads it from the DB. */
export function invalidateTimerCommandCache(): void {
  timerCommandCacheState.invalidate();
}

/**
 * Returns every enabled timer joined with each assigned channel (see
 * `getAllEnabledTimerCommandsWithChannel`), served from cache and loaded on a cold cache.
 * @returns Copies of the cached scheduler rows.
 * @throws If the rows have never loaded successfully (the DB is unreachable on a cold cache).
 */
export async function getEnabledTimerCommandsForScheduler(): Promise<TimerCommandForScheduler[]> {
  const { rows } = await timerCommandCacheState.getCache();
  if (!rows) throw new Error('Timer command cache is not loaded yet (last refresh failed)');
  return rows.map((row) => ({ ...row }));
}
