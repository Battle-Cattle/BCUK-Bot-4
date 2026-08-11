import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

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
  __resetReconciliationCursorsForTests,
} from './twitchEventSubReconciliation';

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  __resetReconciliationCursorsForTests();
  vi.mocked(getStreamerById).mockResolvedValue(streamer);
  vi.mocked(getValidToken).mockResolvedValue('user-token');
  vi.mocked(getCustomRewards).mockResolvedValue([{ id: 'rwd1' } as any]);
  vi.mocked(getRewardRedemptions).mockResolvedValue([]);
  vi.mocked(handleRedemption).mockResolvedValue(undefined);
});

afterEach(async () => {
  await stopEventSubReconciliation();
  vi.useRealTimers();
});

describe('runReconciliationTick', () => {
  it('only baselines a reward on its first tick, without calling handleRedemption', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    vi.mocked(getRewardRedemptions).mockResolvedValue([redemption('r1', new Date().toISOString())]);

    await runReconciliationTick();

    expect(handleRedemption).not.toHaveBeenCalled();
  });

  it('replays a redemption newer than the cursor on a later tick', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    await runReconciliationTick(); // baseline

    const future = new Date(Date.now() + 5_000).toISOString();
    vi.mocked(getRewardRedemptions).mockImplementation(async (_uid, _rewardId, status) =>
      (status === 'FULFILLED' ? [redemption('r1', future)] : []));
    await runReconciliationTick();

    expect(handleRedemption).toHaveBeenCalledTimes(1);
    expect(handleRedemption).toHaveBeenCalledWith(
      'streamerA',
      expect.objectContaining({ id: 'r1', reward: { id: 'rwd1', title: 'Cool Reward' } }),
      config,
      1,
    );
  });

  it('does not replay a redemption older than or equal to the cursor', async () => {
    vi.mocked(getAllStreamerInfo).mockReturnValue(new Map([['uid1', info]]));
    await runReconciliationTick(); // baseline at "now"

    const past = new Date(Date.now() - 60_000).toISOString();
    vi.mocked(getRewardRedemptions).mockResolvedValue([redemption('r1', past)]);
    await runReconciliationTick();

    expect(handleRedemption).not.toHaveBeenCalled();
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
