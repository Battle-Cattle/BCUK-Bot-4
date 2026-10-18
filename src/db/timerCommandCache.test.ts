import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./timerCommands', () => ({ getAllEnabledTimerCommandsWithChannel: vi.fn() }));

import { getAllEnabledTimerCommandsWithChannel, type TimerCommandForScheduler } from './timerCommands';
import { getEnabledTimerCommandsForScheduler, invalidateTimerCommandCache } from './timerCommandCache';
import { DEFAULT_CACHE_TTL_MS, DEFAULT_REFRESH_FAILURE_BACKOFF_MS } from './lookupCache';

function row(overrides: Partial<TimerCommandForScheduler> = {}): TimerCommandForScheduler {
  return { id: 1, channel: 'alice', message: 'hi', interval_seconds: 600, min_messages: 0, require_live: true, ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  invalidateTimerCommandCache();
  vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([row()]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getEnabledTimerCommandsForScheduler', () => {
  it('loads from the DB on a cold cache and serves later reads without querying again', async () => {
    await expect(getEnabledTimerCommandsForScheduler()).resolves.toEqual([row()]);
    await expect(getEnabledTimerCommandsForScheduler()).resolves.toEqual([row()]);
    await vi.advanceTimersByTimeAsync(15_000);
    await getEnabledTimerCommandsForScheduler();
    expect(getAllEnabledTimerCommandsWithChannel).toHaveBeenCalledOnce();
  });

  it('reloads after invalidation', async () => {
    await getEnabledTimerCommandsForScheduler();
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([row({ id: 2 })]);
    invalidateTimerCommandCache();
    await expect(getEnabledTimerCommandsForScheduler()).resolves.toEqual([row({ id: 2 })]);
    expect(getAllEnabledTimerCommandsWithChannel).toHaveBeenCalledTimes(2);
  });

  it('refreshes in the background once the TTL passes, as a safety net for missed invalidations', async () => {
    await getEnabledTimerCommandsForScheduler();
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(DEFAULT_CACHE_TTL_MS);

    // Stale-while-revalidate: this read is served the old rows and kicks off the reload.
    await expect(getEnabledTimerCommandsForScheduler()).resolves.toEqual([row()]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(getEnabledTimerCommandsForScheduler()).resolves.toEqual([]);
    expect(getAllEnabledTimerCommandsWithChannel).toHaveBeenCalledTimes(2);
  });

  it('returns copies, so a caller mutating a row cannot corrupt the cache', async () => {
    const first = await getEnabledTimerCommandsForScheduler();
    first[0]!.message = 'mutated';
    first.length = 0;
    await expect(getEnabledTimerCommandsForScheduler()).resolves.toEqual([row()]);
  });

  it('throws (rather than returning no timers) while the first load keeps failing, then recovers', async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockRejectedValue(new Error('db down'));
    await expect(getEnabledTimerCommandsForScheduler()).rejects.toThrow();
    // Within the backoff window: no new query, still an error.
    await expect(getEnabledTimerCommandsForScheduler()).rejects.toThrow('not loaded');
    expect(getAllEnabledTimerCommandsWithChannel).toHaveBeenCalledOnce();

    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([row()]);
    await vi.advanceTimersByTimeAsync(DEFAULT_REFRESH_FAILURE_BACKOFF_MS);
    await getEnabledTimerCommandsForScheduler().catch(() => undefined); // kicks off the retry
    await vi.advanceTimersByTimeAsync(0);
    await expect(getEnabledTimerCommandsForScheduler()).resolves.toEqual([row()]);
  });

  it('keeps serving the last good rows when a later refresh fails', async () => {
    await getEnabledTimerCommandsForScheduler();
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockRejectedValue(new Error('db down'));
    await vi.advanceTimersByTimeAsync(DEFAULT_CACHE_TTL_MS);
    await expect(getEnabledTimerCommandsForScheduler()).resolves.toEqual([row()]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(getEnabledTimerCommandsForScheduler()).resolves.toEqual([row()]);
  });
});
