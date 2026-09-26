import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockLog, mockLogger } = vi.hoisted(() => {
  const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { mockLog, mockLogger: () => mockLog };
});

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../db', () => ({
  getStreamerById: vi.fn(),
  DEFAULT_EVENT_CONFIG: { follow_enabled: false, sub_enabled: false, raid_enabled: false },
}));
vi.mock('./twitchEventSubDispatch', () => ({ getAllStreamerInfo: vi.fn() }));
vi.mock('./twitchApiEventSub', () => ({ getValidToken: vi.fn() }));
vi.mock('../twitchApi', () => ({ getCustomRewards: vi.fn(), getRewardRedemptions: vi.fn() }));
vi.mock('./twitchEventSubHandler', () => ({ handleRedemption: vi.fn() }));

import { getStreamerById } from '../../db';
import { getAllStreamerInfo } from './twitchEventSubDispatch';
import { getValidToken } from './twitchApiEventSub';
import { getCustomRewards, getRewardRedemptions } from '../twitchApi';
import { handleRedemption } from './twitchEventSubHandler';
import {
  runReconciliationTick, startEventSubReconciliation, stopEventSubReconciliation,
  __resetReconciliationCursorsForTests, nextCursor, CURSOR_RETENTION_MS, MAX_CURSOR_LAG_MS,
} from './twitchEventSubReconciliation';
import { REDEMPTION_DEDUP_TTL_MS } from './twitchEventSubRedemptionDedup';

const streamer = { id: 1, twitch_name: 'streamerA', eventsub_access_token: 'tok' } as any;
const config = { follow_enabled: true } as any;
const info = { login: 'streamerA', streamerId: 1, config };

function redemption(id: string, redeemedAt: string, overrides: Partial<any> = {}) {
  return {
    id, user_id: 'u1', user_login: 'viewer', user_name: 'Viewer', user_input: '',
    status: 'FULFILLED', redeemed_at: redeemedAt,
    reward: { id: 'rwd1', title: 'Cool Reward', prompt: '', cost: 100 },
    ...overrides,
  };
}

/** Only the FULFILLED status call returns `redemptions`; UNFULFILLED always returns an empty page. */
function mockFulfilledOnly(...pages: Array<{ redemptions: ReturnType<typeof redemption>[]; cursor: string | null }>) {
  let call = 0;
  vi.mocked(getRewardRedemptions).mockImplementation(async (_uid, _rewardId, status) => {
    if (status !== 'FULFILLED') return { redemptions: [], cursor: null };
    const page = pages[Math.min(call, pages.length - 1)];
    call++;
    return page;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  __resetReconciliationCursorsForTests();
  vi.mocked(getStreamerById).mockResolvedValue(streamer);
  vi.mocked(getValidToken).mockResolvedValue('user-token');
  vi.mocked(getCustomRewards).mockResolvedValue([{ id: 'rwd1' } as any]);
  vi.mocked(getRewardRedemptions).mockResolvedValue({ redemptions: [], cursor: null });
  vi.mocked(handleRedemption).mockResolvedValue(true);
});

afterEach(async () => {
  await stopEventSubReconciliation();
  vi.useRealTimers();
});

describe('runReconciliationTick', () => {
  it('on the very first tick, replays a redemption within the one-poll-interval lookback window', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    mockFulfilledOnly({ redemptions: [redemption('r1', new Date().toISOString())], cursor: null });

    await runReconciliationTick();

    expect(handleRedemption).toHaveBeenCalledTimes(1);
    expect(handleRedemption).toHaveBeenCalledWith(
      'streamerA',
      expect.objectContaining({ id: 'r1', reward: { id: 'rwd1', title: 'Cool Reward' } }),
      config,
      1,
    );
  });

  it('does not replay a redemption older than the initial one-poll-interval lookback', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    const tooOld = new Date(Date.now() - 120_000).toISOString(); // 2 intervals ago
    mockFulfilledOnly({ redemptions: [redemption('r1', tooOld)], cursor: null });

    await runReconciliationTick();

    expect(handleRedemption).not.toHaveBeenCalled();
  });

  it('replays a redemption newer than the cursor on a later tick', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    await runReconciliationTick(); // establishes the cursor

    const future = new Date(Date.now() + 5_000).toISOString();
    mockFulfilledOnly({ redemptions: [redemption('r1', future)], cursor: null });
    await runReconciliationTick();

    expect(handleRedemption).toHaveBeenCalledTimes(1);
    expect(handleRedemption).toHaveBeenCalledWith(
      'streamerA',
      expect.objectContaining({ id: 'r1', reward: { id: 'rwd1', title: 'Cool Reward' } }),
      config,
      1,
    );
  });

  it('keeps a failed redemption\'s retry position when the streamer is briefly missing from the snapshot', async () => {
    // Tick 1: the redemption fails, pinning the cursor just before it.
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    const failedAt = new Date(Date.now() - 100).toISOString();
    mockFulfilledOnly({ redemptions: [redemption('f1', failedAt)], cursor: null });
    vi.mocked(handleRedemption).mockRejectedValueOnce(new Error('transient'));
    await runReconciliationTick();

    // Tick 2: streamer briefly absent (e.g. an EventSub reconnect).
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map());
    await runReconciliationTick();

    // Tick 3, 90s later: f1 is now older than a fresh one-interval lookback, so it's only retried
    // if the pinned cursor survived the absence.
    vi.advanceTimersByTime(90_000);
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    vi.mocked(handleRedemption).mockClear();
    await runReconciliationTick();

    expect(handleRedemption).toHaveBeenCalledTimes(1);
    expect(handleRedemption).toHaveBeenCalledWith('streamerA', expect.objectContaining({ id: 'f1' }), config, 1);
  });

  it('drops a streamer\'s cursors once they have been missing for longer than CURSOR_RETENTION_MS', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    const failedAt = new Date(Date.now() - 100).toISOString();
    mockFulfilledOnly({ redemptions: [redemption('f1', failedAt)], cursor: null });
    vi.mocked(handleRedemption).mockRejectedValueOnce(new Error('transient'));
    await runReconciliationTick(); // cursor pinned before f1

    // Absent past the retention window — this tick prunes the cursor.
    vi.advanceTimersByTime(CURSOR_RETENTION_MS + 1_000);
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map());
    await runReconciliationTick();

    // On return the cursor restarts from a one-interval lookback, so the old f1 is out of range.
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    vi.mocked(handleRedemption).mockClear();
    await runReconciliationTick();

    expect(handleRedemption).not.toHaveBeenCalled();
  });

  it('drops an expired cursor when a broadcaster returns after an absence and a polling pause longer than CURSOR_RETENTION_MS', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    const failedAt = new Date(Date.now() - 100).toISOString();
    mockFulfilledOnly({ redemptions: [redemption('f1', failedAt)], cursor: null });
    vi.mocked(handleRedemption).mockRejectedValueOnce(new Error('transient'));
    await runReconciliationTick(); // cursor pinned before f1

    // Absent for one tick, within the window — cursor kept.
    vi.advanceTimersByTime(60_000);
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map());
    await runReconciliationTick();

    // Polling pauses past the window; the very next tick already has the broadcaster back.
    vi.advanceTimersByTime(CURSOR_RETENTION_MS + 1_000);
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    vi.mocked(handleRedemption).mockClear();
    await runReconciliationTick();

    // The stale cursor must not survive: the lookback restarts, so the old f1 is out of range.
    expect(handleRedemption).not.toHaveBeenCalled();
  });

  it('drops the cursors of a broadcaster present on every tick when the gap between ticks exceeds CURSOR_RETENTION_MS', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    const failedAt = new Date(Date.now() - 100).toISOString();
    mockFulfilledOnly({ redemptions: [redemption('f1', failedAt)], cursor: null });
    vi.mocked(handleRedemption).mockRejectedValueOnce(new Error('transient'));
    await runReconciliationTick();

    vi.advanceTimersByTime(CURSOR_RETENTION_MS + 1_000); // e.g. reconciliation stopped and restarted
    vi.mocked(handleRedemption).mockClear();
    await runReconciliationTick();

    expect(handleRedemption).not.toHaveBeenCalled();
  });

  it('keeps a failure cursor written at the end of a pass slower than CURSOR_RETENTION_MS', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    const failedAt = new Date(Date.now() - 100).toISOString();
    // The fetch itself stalls past the retention window (e.g. waiting out a Helix rate limit).
    vi.mocked(getRewardRedemptions).mockImplementation(async (_uid, _rewardId, status) => {
      if (status !== 'FULFILLED') return { redemptions: [], cursor: null };
      vi.advanceTimersByTime(CURSOR_RETENTION_MS + 1_000);
      return { redemptions: [redemption('f1', failedAt)], cursor: null };
    });
    vi.mocked(handleRedemption).mockRejectedValueOnce(new Error('transient'));
    await runReconciliationTick(); // cursor pinned before f1, written after the long stall

    // Next tick right away, broadcaster still present: f1 is older than a fresh lookback, so it's
    // only retried if the freshly written cursor survived.
    mockFulfilledOnly({ redemptions: [redemption('f1', failedAt)], cursor: null });
    vi.mocked(handleRedemption).mockClear();
    await runReconciliationTick();

    expect(handleRedemption).toHaveBeenCalledTimes(1);
    expect(handleRedemption).toHaveBeenCalledWith('streamerA', expect.objectContaining({ id: 'f1' }), config, 1);
  });

  it('prunes a success-only cursor after the broadcaster is missing longer than CURSOR_RETENTION_MS', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    const startedAt = Date.now();
    mockFulfilledOnly({ redemptions: [redemption('s1', new Date(startedAt - 100).toISOString())], cursor: null });
    await runReconciliationTick(); // s1 succeeds, cursor lands just before startedAt

    vi.advanceTimersByTime(CURSOR_RETENTION_MS + 1_000);
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map());
    await runReconciliationTick(); // absent past the window — cursor pruned

    // r2 is newer than the old cursor but older than a fresh one-interval lookback, so it's only
    // replayed if the old cursor was (wrongly) kept.
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    mockFulfilledOnly({ redemptions: [redemption('r2', new Date(startedAt + 1_000).toISOString())], cursor: null });
    vi.mocked(handleRedemption).mockClear();
    await runReconciliationTick();

    expect(handleRedemption).not.toHaveBeenCalled();
  });

  it('keeps the retention window inside the redemption dedup TTL', () => {
    expect(CURSOR_RETENTION_MS).toBeLessThan(REDEMPTION_DEDUP_TTL_MS);
  });

  it('abandons a redemption that keeps failing for longer than MAX_CURSOR_LAG_MS, with a warning', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    const t0 = Date.now();
    const page = { redemptions: [redemption('s2', new Date(t0 + 1_000).toISOString()), redemption('f1', new Date(t0).toISOString())], cursor: null };
    mockFulfilledOnly(page);
    vi.mocked(handleRedemption).mockImplementation(async (_login, event: any) => {
      if (event.id === 'f1') throw new Error('permanent');
      return true;
    });

    // Present and failing on every tick, one poll interval apart, until the cap is passed.
    let lastTickReplayed: string[] = [];
    while (Date.now() - t0 <= MAX_CURSOR_LAG_MS + 60_000) {
      vi.mocked(handleRedemption).mockClear();
      await runReconciliationTick();
      lastTickReplayed = vi.mocked(handleRedemption).mock.calls.map((c) => (c[1] as any).id);
      vi.advanceTimersByTime(60_000);
    }

    // Neither the failure nor the success after it is replayed once the cap has moved the cursor.
    expect(lastTickReplayed).toEqual([]);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Abandoning reconciliation retry for reward rwd1 (streamerA)'));
  });

  it('keeps retrying a failed redemption younger than MAX_CURSOR_LAG_MS, without an abandon warning', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    const t0 = Date.now();
    mockFulfilledOnly({ redemptions: [redemption('f1', new Date(t0).toISOString())], cursor: null });
    vi.mocked(handleRedemption).mockRejectedValue(new Error('transient'));
    await runReconciliationTick(); // cursor pinned just before f1

    // Keep the broadcaster fresh with ticks inside the retention window, stopping just short of the cap.
    while (Date.now() - t0 < MAX_CURSOR_LAG_MS - 60_000) {
      vi.advanceTimersByTime(60_000);
      await runReconciliationTick();
    }
    vi.advanceTimersByTime(MAX_CURSOR_LAG_MS - 1_000 - (Date.now() - t0));
    vi.mocked(handleRedemption).mockClear();
    await runReconciliationTick();

    expect(handleRedemption).toHaveBeenCalledTimes(1);
    expect(handleRedemption).toHaveBeenCalledWith('streamerA', expect.objectContaining({ id: 'f1' }), config, 1);
    expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('Abandoning'));
  });

  it('floors a quiet reward\'s success cursor at MAX_CURSOR_LAG_MS without an abandon warning', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    const t0 = Date.now();
    mockFulfilledOnly({ redemptions: [redemption('s1', new Date(t0 - 100).toISOString())], cursor: null });
    await runReconciliationTick(); // cursor lands on s1

    // No new redemptions for longer than the cap; the broadcaster stays present every tick.
    mockFulfilledOnly({ redemptions: [], cursor: null });
    while (Date.now() - t0 <= MAX_CURSOR_LAG_MS + 60_000) {
      vi.advanceTimersByTime(60_000);
      await runReconciliationTick();
    }

    // A late-arriving redemption from before the floor isn't replayed; one after it is.
    const floor = Date.now() - MAX_CURSOR_LAG_MS;
    mockFulfilledOnly({
      redemptions: [redemption('new', new Date(floor + 1_000).toISOString()), redemption('old', new Date(floor - 1_000).toISOString())],
      cursor: null,
    });
    vi.mocked(handleRedemption).mockClear();
    await runReconciliationTick();

    expect(vi.mocked(handleRedemption).mock.calls.map((c) => (c[1] as any).id)).toEqual(['new']);
    expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('Abandoning'));
    expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('Skipping unreconciled'));
  });

  it('skips a redemption that ages past MAX_CURSOR_LAG_MS during a slow fetch, still handling newer ones', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    const t0 = Date.now();
    await runReconciliationTick(); // quiet: cursor stays at the initial lookback, t0 - one interval
    while (Date.now() - t0 < MAX_CURSOR_LAG_MS - 2 * 60_000) {
      vi.advanceTimersByTime(60_000);
      await runReconciliationTick();
    }

    // The cutoff is still inside the cap when chosen, but the fetch stalls for two intervals, so by
    // handling time 'old' is past the cap (its dedup entry may have expired) while 'new' is not.
    const oldAt = t0 - 30_000;
    const newAt = Date.now() - 1_000;
    vi.mocked(getRewardRedemptions).mockImplementation(async (_uid, _rewardId, status) => {
      if (status !== 'FULFILLED') return { redemptions: [], cursor: null };
      vi.advanceTimersByTime(2 * 60_000);
      return { redemptions: [redemption('new', new Date(newAt).toISOString()), redemption('old', new Date(oldAt).toISOString())], cursor: null };
    });
    await runReconciliationTick();

    expect(vi.mocked(handleRedemption).mock.calls.map((c) => (c[1] as any).id)).toEqual(['new']);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping reconciliation replay of redemption old (streamerA)'));
  });

  it('warns when the cap skips a window whose redemptions could not be fetched', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    const t0 = Date.now();
    await runReconciliationTick(); // establishes a quiet cursor

    vi.mocked(getRewardRedemptions).mockRejectedValue(new Error('helix down'));
    while (Date.now() - t0 <= MAX_CURSOR_LAG_MS + 60_000) {
      vi.advanceTimersByTime(60_000);
      await runReconciliationTick();
    }

    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping unreconciled redemptions for reward rwd1 (streamerA)'));
    expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('Abandoning'));
  });

  it('warns when the cap skips a window during which the streamer\'s rewards could not be listed', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    const t0 = Date.now();
    await runReconciliationTick(); // establishes a quiet cursor for rwd1

    vi.mocked(getCustomRewards).mockRejectedValue(new Error('helix down'));
    while (Date.now() - t0 <= MAX_CURSOR_LAG_MS + 60_000) {
      vi.advanceTimersByTime(60_000);
      await runReconciliationTick();
    }
    expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('Skipping unreconciled'));

    vi.mocked(getCustomRewards).mockResolvedValue([{ id: 'rwd1' } as any]);
    await runReconciliationTick();

    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping unreconciled redemptions for reward rwd1 (streamerA)'));
  });

  it('warns when the cap skips a window during which the streamer had no usable token', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    const t0 = Date.now();
    await runReconciliationTick(); // establishes a quiet cursor for rwd1

    vi.mocked(getValidToken).mockResolvedValue(null);
    while (Date.now() - t0 <= MAX_CURSOR_LAG_MS + 60_000) {
      vi.advanceTimersByTime(60_000);
      await runReconciliationTick();
    }
    expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('Skipping unreconciled'));

    vi.mocked(getValidToken).mockResolvedValue('user-token');
    await runReconciliationTick();

    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping unreconciled redemptions for reward rwd1 (streamerA)'));
  });

  it('keeps the cursor lag cap at least one poll interval inside the redemption dedup TTL', () => {
    expect(MAX_CURSOR_LAG_MS).toBeGreaterThan(0);
    expect(MAX_CURSOR_LAG_MS + 60_000).toBeLessThanOrEqual(REDEMPTION_DEDUP_TTL_MS);
  });

  it('does not replay a redemption older than or equal to the cursor', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    await runReconciliationTick(); // cursor lands at "now"

    const past = new Date(Date.now() - 60_000).toISOString();
    mockFulfilledOnly({ redemptions: [redemption('r1', past)], cursor: null });
    await runReconciliationTick();

    expect(handleRedemption).not.toHaveBeenCalled();
  });

  it('pages through results, stopping as soon as a page reaches the cutoff', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    await runReconciliationTick(); // establishes the cursor one poll interval before "now"

    const cutoff = Date.now() - 60_000; // the cursor established by the tick above
    const page1 = [redemption('r3', new Date(cutoff + 3_000).toISOString()), redemption('r2', new Date(cutoff + 2_000).toISOString())];
    // page 2 includes one redemption at-or-before the cutoff — pagination must stop there without using its cursor.
    const page2 = [redemption('r1', new Date(cutoff + 1_000).toISOString()), redemption('r0', new Date(cutoff - 5_000).toISOString())];
    mockFulfilledOnly(
      { redemptions: page1, cursor: 'page-2-cursor' },
      { redemptions: page2, cursor: 'page-3-cursor' },
    );
    vi.mocked(getRewardRedemptions).mockClear();

    await runReconciliationTick();

    const handledIds = vi.mocked(handleRedemption).mock.calls.map(([, event]) => (event as any).id);
    expect(handledIds.sort()).toEqual(['r1', 'r2', 'r3']);
    // Only 2 pages fetched for the FULFILLED status — page 2's cutoff redemption stopped a 3rd page fetch.
    const fulfilledCalls = vi.mocked(getRewardRedemptions).mock.calls.filter(([, , status]) => status === 'FULFILLED');
    expect(fulfilledCalls).toHaveLength(2);
    expect(fulfilledCalls[1][4]).toBe('page-2-cursor'); // second call passed the first page's cursor as `after`
  });

  it('does not advance the cursor past a redemption that fails to handle, so it is retried on the next tick', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    await runReconciliationTick(); // establishes the cursor at "now"

    const redeemedAt = new Date(Date.now() + 1_000).toISOString();
    mockFulfilledOnly({ redemptions: [redemption('r1', redeemedAt)], cursor: null });
    vi.mocked(handleRedemption).mockRejectedValueOnce(new Error('handler boom'));

    await runReconciliationTick();
    expect(handleRedemption).toHaveBeenCalledTimes(1);

    // Cursor wasn't advanced past the failure — the same redemption is fetched and retried.
    vi.mocked(handleRedemption).mockResolvedValue(true);
    await runReconciliationTick();

    expect(handleRedemption).toHaveBeenCalledTimes(2);
    expect(vi.mocked(handleRedemption).mock.calls[1][1]).toEqual(expect.objectContaining({ id: 'r1' }));
  });

  it('advances the cursor past redemptions that succeeded even when a later one in the same tick fails', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    await runReconciliationTick(); // establishes the cursor at "now"

    const t1 = new Date(Date.now() + 1_000).toISOString();
    const t2 = new Date(Date.now() + 2_000).toISOString();
    const t3 = new Date(Date.now() + 3_000).toISOString();
    mockFulfilledOnly({ redemptions: [redemption('r3', t3), redemption('r2', t2), redemption('r1', t1)], cursor: null });
    vi.mocked(handleRedemption).mockImplementation(async (_login, event: any) => {
      if (event.id === 'r3') throw new Error('handler boom');
      return true;
    });

    await runReconciliationTick();
    expect(handleRedemption).toHaveBeenCalledTimes(3);

    // Next tick should only retry the failed redemption (r3), not the two that already succeeded —
    // return the full page (as Twitch would) so this actually exercises the cursor's own cutoff
    // filtering in fetchRedemptionsNewerThan, rather than passing merely because the mock omitted r1/r2.
    vi.mocked(handleRedemption).mockClear();
    vi.mocked(handleRedemption).mockResolvedValue(true);
    mockFulfilledOnly({ redemptions: [redemption('r3', t3), redemption('r2', t2), redemption('r1', t1)], cursor: null });

    await runReconciliationTick();

    expect(handleRedemption).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handleRedemption).mock.calls[0][1]).toEqual(expect.objectContaining({ id: 'r3' }));
  });

  it('logs a "caught" warning only when handleRedemption reports it actually processed the redemption', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    mockFulfilledOnly({ redemptions: [redemption('r1', new Date().toISOString())], cursor: null });
    vi.mocked(handleRedemption).mockResolvedValue(true);

    await runReconciliationTick();

    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Reconciliation caught a redemption missed by EventSub'));
  });

  it('does not log a "caught" warning when handleRedemption reports the redemption was already handled live (duplicate)', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    mockFulfilledOnly({ redemptions: [redemption('r1', new Date().toISOString())], cursor: null });
    vi.mocked(handleRedemption).mockResolvedValue(false);

    await runReconciliationTick();

    expect(handleRedemption).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('Reconciliation caught a redemption missed by EventSub'));
  });

  it('skips a streamer with no config row — they never got the redemption subscription in the first place', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', { ...info, config: null }]]));
    await runReconciliationTick();
    expect(getStreamerById).not.toHaveBeenCalled();
  });

  it('skips a streamer with no valid broadcaster token', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    vi.mocked(getValidToken).mockResolvedValue(null);

    await runReconciliationTick();

    expect(getCustomRewards).not.toHaveBeenCalled();
  });

  it('continues to the next streamer when one fails to list custom rewards', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([
      ['uid1', info],
      ['uid2', { login: 'streamerB', streamerId: 2, config }],
    ]));
    vi.mocked(getStreamerById).mockImplementation(async (id) => (id === 1 ? streamer : { ...streamer, id: 2 }));
    vi.mocked(getCustomRewards).mockImplementation(async (uid) => {
      if (uid === 'uid1') throw new Error('helix down');
      return [{ id: 'rwd2' } as any];
    });

    await expect(runReconciliationTick()).resolves.toBeUndefined();
    expect(getCustomRewards).toHaveBeenCalledTimes(2);
  });

  it('reuses the in-flight tick promise instead of starting a second concurrent tick', async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    vi.mocked(getStreamerById).mockImplementation(async () => { await gate; return streamer; });

    const first = runReconciliationTick();
    const second = runReconciliationTick();

    resolveFirst();
    await Promise.all([first, second]);

    expect(getStreamerById).toHaveBeenCalledTimes(1);
  });
});

describe('startEventSubReconciliation / stopEventSubReconciliation', () => {
  it('fires runReconciliationTick on the configured interval and stops on request', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map());
    startEventSubReconciliation();

    expect(getAllStreamerInfo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getAllStreamerInfo).toHaveBeenCalledTimes(1);

    await stopEventSubReconciliation();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getAllStreamerInfo).toHaveBeenCalledTimes(1);
  });

  it('does not leak the interval when started twice without stopping', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map());
    startEventSubReconciliation();
    startEventSubReconciliation();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getAllStreamerInfo).toHaveBeenCalledTimes(1);
  });
});

describe('nextCursor', () => {
  it('stays at the cutoff when nothing succeeded or failed', () => {
    expect(nextCursor(100, null, null)).toBe(100);
  });

  it('advances to the latest success when nothing failed', () => {
    expect(nextCursor(100, 250, null)).toBe(250);
  });

  it('pins just before the earliest failure, even when later redemptions succeeded', () => {
    expect(nextCursor(100, 400, 200)).toBe(199);
  });

  it('pins just before the earliest failure when nothing succeeded', () => {
    expect(nextCursor(100, null, 150)).toBe(149);
  });
});
