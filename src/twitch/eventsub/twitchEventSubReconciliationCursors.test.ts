import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLog, mockLogger } = vi.hoisted(() => {
  const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { mockLog, mockLogger: () => mockLog };
});

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import {
  RECONCILIATION_POLL_INTERVAL_MS,
  MAX_CURSOR_LAG_MS,
  CURSOR_RETENTION_MS,
  nextCursor,
  recordReplayOutcome,
  markFetchFailed,
  markStreamerFetchFailed,
  resolveCutoff,
  pruneStaleReconciliationCursors,
  markBroadcastersSeen,
  __resetReconciliationCursorStateForTests,
} from './twitchEventSubReconciliationCursors';

const NOW = 1_800_000_000_000;
const KEY = 'uid1:reward-a';

function warnings(): string[] {
  return mockLog.warn.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  __resetReconciliationCursorStateForTests();
  vi.clearAllMocks();
});

describe('nextCursor', () => {
  it('pins just before the earliest failure, even when later redemptions succeeded', () => {
    expect(nextCursor(100, 500, 300)).toBe(299);
  });

  it('advances to the latest success when nothing failed', () => {
    expect(nextCursor(100, 500, null)).toBe(500);
  });

  it('pins just before the earliest failure when nothing succeeded', () => {
    expect(nextCursor(100, null, 150)).toBe(149);
  });

  it('stays at the cutoff when nothing was handled', () => {
    expect(nextCursor(100, null, null)).toBe(100);
  });
});

describe('resolveCutoff', () => {
  it('looks back one poll interval for a reward with no cursor yet', () => {
    expect(resolveCutoff(KEY, 'alice', NOW)).toBe(NOW - RECONCILIATION_POLL_INTERVAL_MS);
  });

  it('resumes from a stored cursor inside the lag cap', () => {
    recordReplayOutcome(KEY, NOW - 5_000, NOW - 1_000, null);
    expect(resolveCutoff(KEY, 'alice', NOW)).toBe(NOW - 1_000);
  });

  it('floors a quiet success cursor at the lag cap without warning', () => {
    recordReplayOutcome(KEY, NOW - MAX_CURSOR_LAG_MS - 10_000, null, null);
    expect(resolveCutoff(KEY, 'alice', NOW)).toBe(NOW - MAX_CURSOR_LAG_MS);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('warns that a failing redemption is abandoned when the cap moves a handler pin', () => {
    const failedAt = NOW - MAX_CURSOR_LAG_MS - 10_000;
    recordReplayOutcome(KEY, failedAt - 1_000, null, failedAt);
    expect(resolveCutoff(KEY, 'alice', NOW)).toBe(NOW - MAX_CURSOR_LAG_MS);
    expect(warnings()).toEqual([expect.stringContaining('Abandoning reconciliation retry for reward reward-a (alice)')]);
    expect(warnings()[0]).toContain(new Date(failedAt).toISOString());
  });
});

describe('recordReplayOutcome', () => {
  it('stores the cursor just before the earliest failure so it is retried', () => {
    recordReplayOutcome(KEY, NOW - 50_000, NOW - 1_000, NOW - 20_000);
    expect(resolveCutoff(KEY, 'alice', NOW)).toBe(NOW - 20_001);
  });

  it('clears an earlier fetch pin, so a later cap move is silent', () => {
    const old = NOW - MAX_CURSOR_LAG_MS - 10_000;
    markFetchFailed(KEY, old);
    recordReplayOutcome(KEY, old, null, null);
    resolveCutoff(KEY, 'alice', NOW);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });
});

describe('markFetchFailed', () => {
  it('pins the cursor at the failed cutoff', () => {
    markFetchFailed(KEY, NOW - 30_000);
    expect(resolveCutoff(KEY, 'alice', NOW)).toBe(NOW - 30_000);
  });

  it('warns once per outage when the cap skips an unfetched window', () => {
    const start = NOW - MAX_CURSOR_LAG_MS - 10_000;
    markFetchFailed(KEY, start);
    for (let tick = 0; tick < 3; tick++) {
      const now = NOW + tick * RECONCILIATION_POLL_INTERVAL_MS;
      markFetchFailed(KEY, resolveCutoff(KEY, 'alice', now));
    }
    expect(warnings()).toEqual([expect.stringContaining('Skipping unreconciled redemptions for reward reward-a (alice)')]);
  });

  it('warns again for a separate outage after a successful fetch', () => {
    const start = NOW - MAX_CURSOR_LAG_MS - 10_000;
    markFetchFailed(KEY, start);
    markFetchFailed(KEY, resolveCutoff(KEY, 'alice', NOW));
    recordReplayOutcome(KEY, NOW - MAX_CURSOR_LAG_MS, null, null);

    const later = NOW + 2 * MAX_CURSOR_LAG_MS;
    markFetchFailed(KEY, resolveCutoff(KEY, 'alice', later));
    resolveCutoff(KEY, 'alice', later + MAX_CURSOR_LAG_MS + 10_000);
    expect(warnings().filter((w) => w.startsWith('Skipping'))).toHaveLength(2);
  });

  it('keeps a handler pin that is still at the failed cutoff', () => {
    const failedAt = NOW - MAX_CURSOR_LAG_MS - 10_000;
    recordReplayOutcome(KEY, failedAt - 1_000, null, failedAt);
    markFetchFailed(KEY, failedAt - 1);
    resolveCutoff(KEY, 'alice', NOW);
    expect(warnings()).toEqual([expect.stringContaining('Abandoning reconciliation retry')]);
  });

  it('replaces a handler pin the cap already moved past with a fetch pin', () => {
    const failedAt = NOW - MAX_CURSOR_LAG_MS - 10_000;
    recordReplayOutcome(KEY, failedAt - 1_000, null, failedAt);
    const floor = resolveCutoff(KEY, 'alice', NOW);
    markFetchFailed(KEY, floor);
    resolveCutoff(KEY, 'alice', NOW + MAX_CURSOR_LAG_MS + 1);
    expect(warnings()).toEqual([
      expect.stringContaining('Abandoning reconciliation retry'),
      expect.stringContaining('Skipping unreconciled redemptions'),
    ]);
  });
});

describe('markStreamerFetchFailed', () => {
  it('fetch-pins only that broadcaster\'s cursors, matching the uid exactly', () => {
    const old = NOW - MAX_CURSOR_LAG_MS - 10_000;
    recordReplayOutcome('uid1:reward-a', old, null, null);
    recordReplayOutcome('uid1:reward-b', old, null, null);
    recordReplayOutcome('uid12:reward-c', old, null, null);

    markStreamerFetchFailed('uid1');
    resolveCutoff('uid1:reward-a', 'alice', NOW);
    resolveCutoff('uid1:reward-b', 'alice', NOW);
    resolveCutoff('uid12:reward-c', 'bob', NOW);

    expect(warnings()).toEqual([
      expect.stringContaining('reward reward-a (alice)'),
      expect.stringContaining('reward reward-b (alice)'),
    ]);
  });

  it('creates no cursors for a broadcaster with none tracked', () => {
    markStreamerFetchFailed('uid1');
    expect(resolveCutoff(KEY, 'alice', NOW)).toBe(NOW - RECONCILIATION_POLL_INTERVAL_MS);
  });
});

describe('pruneStaleReconciliationCursors', () => {
  const pinned = NOW - 30_000;

  it('drops cursors of a broadcaster never marked seen', () => {
    markFetchFailed(KEY, pinned);
    pruneStaleReconciliationCursors(new Set(), NOW);
    expect(resolveCutoff(KEY, 'alice', NOW)).toBe(NOW - RECONCILIATION_POLL_INTERVAL_MS);
  });

  it('keeps cursors through an absence up to the retention window', () => {
    markBroadcastersSeen(new Set(['uid1']), NOW);
    markFetchFailed(KEY, pinned);
    pruneStaleReconciliationCursors(new Set(), NOW + CURSOR_RETENTION_MS);
    expect(resolveCutoff(KEY, 'alice', NOW)).toBe(pinned);
  });

  it('drops cursors once the absence exceeds the retention window', () => {
    markBroadcastersSeen(new Set(['uid1']), NOW);
    markFetchFailed(KEY, pinned);
    pruneStaleReconciliationCursors(new Set(), NOW + CURSOR_RETENTION_MS + 1);
    expect(resolveCutoff(KEY, 'alice', NOW)).toBe(NOW - RECONCILIATION_POLL_INTERVAL_MS);
  });

  it('expires a stale broadcaster before refreshing them, even if present again this tick', () => {
    markBroadcastersSeen(new Set(['uid1']), NOW);
    markFetchFailed(KEY, pinned);
    pruneStaleReconciliationCursors(new Set(['uid1']), NOW + CURSOR_RETENTION_MS + 1);
    expect(resolveCutoff(KEY, 'alice', NOW)).toBe(NOW - RECONCILIATION_POLL_INTERVAL_MS);
  });

  it('refreshes present broadcasters so their cursors survive the next window', () => {
    markBroadcastersSeen(new Set(['uid1']), NOW);
    markFetchFailed(KEY, pinned);
    pruneStaleReconciliationCursors(new Set(['uid1']), NOW + CURSOR_RETENTION_MS);
    pruneStaleReconciliationCursors(new Set(), NOW + 2 * CURSOR_RETENTION_MS);
    expect(resolveCutoff(KEY, 'alice', NOW)).toBe(pinned);
  });
});

describe('__resetReconciliationCursorStateForTests', () => {
  it('clears cursors and last-seen times', () => {
    markBroadcastersSeen(new Set(['uid1']), NOW);
    markFetchFailed(KEY, NOW - 30_000);
    __resetReconciliationCursorStateForTests();
    expect(resolveCutoff(KEY, 'alice', NOW)).toBe(NOW - RECONCILIATION_POLL_INTERVAL_MS);
    markFetchFailed(KEY, NOW - 30_000);
    pruneStaleReconciliationCursors(new Set(), NOW);
    expect(resolveCutoff(KEY, 'alice', NOW)).toBe(NOW - RECONCILIATION_POLL_INTERVAL_MS);
  });
});
