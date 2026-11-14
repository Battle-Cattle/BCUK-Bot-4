import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../db', () => ({
  getStreamerById: vi.fn(),
  markPricingUnsupported: vi.fn(),
}));
vi.mock('../twitchUserTokens', () => ({ getValidToken: vi.fn() }));
vi.mock('../twitchRewardsApi', () => {
  class TwitchRewardUnsupportedError extends Error {}
  class TwitchRewardAuthError extends Error {}
  return { updateRewardCost: vi.fn(), TwitchRewardUnsupportedError, TwitchRewardAuthError };
});

import { getStreamerById, markPricingUnsupported } from '../../db';
import { getValidToken } from '../twitchUserTokens';
import { updateRewardCost, TwitchRewardUnsupportedError, TwitchRewardAuthError } from '../twitchRewardsApi';
import { rewardKey, resolveBroadcasterToken, pushRewardCostUpdate, __resetPushRateLimiterForTests } from './rewardPricePush';

const streamer = { id: 1, twitch_user_id: 'bc1' } as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  __resetPushRateLimiterForTests();
  vi.mocked(getStreamerById).mockResolvedValue(streamer);
  vi.mocked(getValidToken).mockResolvedValue('user-token');
  vi.mocked(updateRewardCost).mockResolvedValue(undefined);
});

describe('rewardKey', () => {
  it('keys a reward by its streamer and Twitch reward id', () => {
    expect(rewardKey(3, 'rwd1')).toBe('3:rwd1');
  });
});

describe('resolveBroadcasterToken', () => {
  it('returns the streamer and their valid token', async () => {
    await expect(resolveBroadcasterToken(1)).resolves.toEqual({ streamer, token: 'user-token' });
  });

  it('returns null when the streamer does not exist', async () => {
    vi.mocked(getStreamerById).mockResolvedValue(null);
    await expect(resolveBroadcasterToken(1)).resolves.toBeNull();
    expect(getValidToken).not.toHaveBeenCalled();
  });

  it('returns null when the streamer has no linked Twitch account', async () => {
    vi.mocked(getStreamerById).mockResolvedValue({ ...streamer, twitch_user_id: null });
    await expect(resolveBroadcasterToken(1)).resolves.toBeNull();
  });

  it('returns null when there is no usable token', async () => {
    vi.mocked(getValidToken).mockResolvedValue(null);
    await expect(resolveBroadcasterToken(1)).resolves.toBeNull();
  });
});

describe('pushRewardCostUpdate', () => {
  it('pushes the new cost and returns it as the cost to persist', async () => {
    await expect(pushRewardCostUpdate(1, 'rwd1', 300, 200)).resolves.toEqual({ lastPushedCost: 300, unsupported: false });
    expect(updateRewardCost).toHaveBeenCalledExactlyOnceWith('bc1', 'rwd1', 300, 'user-token');
  });

  it('skips a push for the same reward within the rate-limit window, without any lookups', async () => {
    vi.useFakeTimers();
    await pushRewardCostUpdate(1, 'rwd1', 300, 200);
    vi.clearAllMocks();

    await expect(pushRewardCostUpdate(1, 'rwd1', 400, 300)).resolves.toEqual({ lastPushedCost: 300, unsupported: false });
    expect(getStreamerById).not.toHaveBeenCalled();
    expect(updateRewardCost).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pushRewardCostUpdate(1, 'rwd1', 400, 300)).resolves.toEqual({ lastPushedCost: 400, unsupported: false });
  });

  it('keeps the previous cost when there is no valid broadcaster token', async () => {
    vi.mocked(getValidToken).mockResolvedValue(null);
    await expect(pushRewardCostUpdate(1, 'rwd1', 300, 200)).resolves.toEqual({ lastPushedCost: 200, unsupported: false });
    expect(updateRewardCost).not.toHaveBeenCalled();
  });

  it('marks the reward unsupported on a 403', async () => {
    vi.mocked(updateRewardCost).mockRejectedValue(new TwitchRewardUnsupportedError('403'));
    await expect(pushRewardCostUpdate(1, 'rwd1', 300, 200)).resolves.toEqual({ lastPushedCost: 200, unsupported: true });
    expect(markPricingUnsupported).toHaveBeenCalledExactlyOnceWith(1, 'rwd1');
  });

  it('keeps the previous cost, without marking it unsupported, on a 401 or any other failure', async () => {
    vi.mocked(updateRewardCost)
      .mockRejectedValueOnce(new TwitchRewardAuthError('401'))
      .mockRejectedValueOnce(new Error('network'));

    await expect(pushRewardCostUpdate(1, 'rwd1', 300, 200)).resolves.toEqual({ lastPushedCost: 200, unsupported: false });
    await expect(pushRewardCostUpdate(1, 'rwd1', 300, 200)).resolves.toEqual({ lastPushedCost: 200, unsupported: false });
    expect(markPricingUnsupported).not.toHaveBeenCalled();
  });
});
