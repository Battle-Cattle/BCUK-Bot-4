import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../shared/config', () => ({
  TWITCH_CLIENT_ID: 'test-client-id',
  TWITCH_CLIENT_SECRET: 'test-client-secret',
}));

import { getAppToken } from './twitchApi';
import {
  getCustomRewards, updateRewardCost, createCustomReward, updateCustomReward, deleteCustomReward,
  getRewardRedemptions, updateRedemptionStatus,
  TwitchRewardUnsupportedError, TwitchRewardAuthError, TwitchRedemptionNotFoundError,
} from './twitchRewardsApi';

const TOKEN_RESPONSE = { access_token: 'test-token', expires_in: 3600 };

function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: { get: (key: string) => headers[key] ?? null },
  } as unknown as Response;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  // Warm the token cache so each test only needs to mock the helix calls.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, TOKEN_RESPONSE));
  await getAppToken();
  vi.clearAllMocks(); // reset call counts, keep the spy's default implementation
});

describe('getCustomRewards', () => {
  it('sends a GET with the broadcaster_id query param, returning the reward list', async () => {
    const rewards = [{ id: 'rwd1', title: 'Cool Reward', cost: 500 }];
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: rewards }));

    const result = await getCustomRewards('bc1', 'user-token');

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toContain('broadcaster_id=bc1');
    expect(init?.method).toBeUndefined(); // defaults to GET
    expect(result).toEqual(rewards);
    expect(String(url)).not.toContain('only_manageable_rewards');
  });

  it('restricts the listing to rewards this app can manage when onlyManageable is set', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: [] }));

    await getCustomRewards('bc1', 'user-token', { onlyManageable: true });

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toContain('broadcaster_id=bc1');
    expect(String(url)).toContain('only_manageable_rewards=true');
  });

  it('throws with the response status on a 401 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(401, {}));
    await expect(getCustomRewards('bc1', 'user-token')).rejects.toThrow('getCustomRewards failed: 401');
  });

  it('keeps the cached app token on a 401, since the call used a user token', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(401, {}));
    await expect(getCustomRewards('bc1', 'user-token')).rejects.toThrow('getCustomRewards failed: 401');

    expect(await getAppToken()).toBe('test-token');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // the 401 only, no token re-fetch
  });

  it('returns an empty array on a 403 response, rather than throwing', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(403, {}));
    expect(await getCustomRewards('bc1', 'user-token')).toEqual([]);
  });

  it('throws a generic error for other non-OK statuses', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(500, {}));
    await expect(getCustomRewards('bc1', 'user-token')).rejects.toThrow('getCustomRewards failed: 500');
  });

  it('retries after a transient network error and returns the successful result', async () => {
    vi.useFakeTimers();
    const rewards = [{ id: 'rwd1', title: 'Cool Reward', cost: 500 }];
    vi.mocked(globalThis.fetch)
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(mockResponse(200, { data: rewards }));

    const promise = getCustomRewards('bc1', 'user-token');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual(rewards);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('getRewardRedemptions', () => {
  it('sends a GET with broadcaster_id, reward_id, and status query params, returning the redemption page', async () => {
    const redemptions = [{ id: 'redemp1', user_login: 'viewer1', status: 'UNFULFILLED' }];
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: redemptions, pagination: { cursor: 'next-page' } }));

    const result = await getRewardRedemptions('bc1', 'rwd1', 'UNFULFILLED', 'user-token');

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toContain('broadcaster_id=bc1');
    expect(String(url)).toContain('reward_id=rwd1');
    expect(String(url)).toContain('status=UNFULFILLED');
    expect(String(url)).toContain('sort=NEWEST');
    expect(String(url)).not.toContain('after=');
    expect(init?.method).toBeUndefined(); // defaults to GET
    expect(result).toEqual({ redemptions, cursor: 'next-page' });
  });

  it('includes the after cursor when paginating to a later page', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: [] }));

    await getRewardRedemptions('bc1', 'rwd1', 'UNFULFILLED', 'user-token', 'cursor-abc');

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toContain('after=cursor-abc');
  });

  it('returns a null cursor when the response has no pagination field', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: [] }));
    const result = await getRewardRedemptions('bc1', 'rwd1', 'UNFULFILLED', 'user-token');
    expect(result.cursor).toBeNull();
  });

  it('throws with the response status on a 401 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(401, {}));
    await expect(getRewardRedemptions('bc1', 'rwd1', 'FULFILLED', 'user-token')).rejects.toThrow('getRewardRedemptions failed: 401');
  });

  it('returns an empty page with a null cursor on a 403 response, rather than throwing', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(403, {}));
    expect(await getRewardRedemptions('bc1', 'rwd1', 'UNFULFILLED', 'user-token')).toEqual({ redemptions: [], cursor: null });
  });

  it('throws a generic error for other non-OK statuses', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(500, {}));
    await expect(getRewardRedemptions('bc1', 'rwd1', 'UNFULFILLED', 'user-token')).rejects.toThrow('getRewardRedemptions failed: 500');
  });

  it('retries after a transient network error and returns the successful result', async () => {
    vi.useFakeTimers();
    const redemptions = [{ id: 'redemp1', user_login: 'viewer1', status: 'UNFULFILLED' }];
    vi.mocked(globalThis.fetch)
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(mockResponse(200, { data: redemptions }));

    const promise = getRewardRedemptions('bc1', 'rwd1', 'UNFULFILLED', 'user-token');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ redemptions, cursor: null });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('updateRewardCost', () => {
  it('sends a PATCH with broadcaster_id and id query params and the new cost in the body', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: [{ id: 'rwd1', cost: 500 }] }));
    await updateRewardCost('bc1', 'rwd1', 500, 'user-token');

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toContain('broadcaster_id=bc1');
    expect(String(url)).toContain('id=rwd1');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ cost: 500 }));
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('throws with the response status on a non-OK response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(400, {}));
    await expect(updateRewardCost('bc1', 'rwd1', 500, 'user-token')).rejects.toThrow('updateCustomReward failed: 400');
  });

  it('does not retry on failure (single fetch call)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(500, {}));
    await expect(updateRewardCost('bc1', 'rwd1', 500, 'user-token')).rejects.toThrow();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('throws TwitchRewardUnsupportedError specifically on a 403 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(403, {}));
    await expect(updateRewardCost('bc1', 'rwd1', 500, 'user-token')).rejects.toBeInstanceOf(TwitchRewardUnsupportedError);
  });

  it('does not throw TwitchRewardUnsupportedError for other non-OK statuses', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(400, {}));
    await expect(updateRewardCost('bc1', 'rwd1', 500, 'user-token')).rejects.not.toBeInstanceOf(TwitchRewardUnsupportedError);
  });

  it('throws TwitchRewardAuthError specifically on a 401 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(401, {}));
    await expect(updateRewardCost('bc1', 'rwd1', 500, 'user-token')).rejects.toBeInstanceOf(TwitchRewardAuthError);
  });

  it('does not throw TwitchRewardAuthError for other non-OK statuses', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(400, {}));
    await expect(updateRewardCost('bc1', 'rwd1', 500, 'user-token')).rejects.not.toBeInstanceOf(TwitchRewardAuthError);
  });
});

describe('createCustomReward', () => {
  const input = { title: 'Cool Reward', cost: 500 };

  it('sends a POST with broadcaster_id and the input as the body, returning the created reward', async () => {
    const created = { id: 'rwd1', title: 'Cool Reward', cost: 500 };
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: [created] }));

    const result = await createCustomReward('bc1', 'user-token', input);

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toContain('broadcaster_id=bc1');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify(input));
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(result).toEqual(created);
  });

  it('throws TwitchRewardUnsupportedError on a 403 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(403, {}));
    await expect(createCustomReward('bc1', 'user-token', input)).rejects.toBeInstanceOf(TwitchRewardUnsupportedError);
  });

  it('throws TwitchRewardAuthError on a 401 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(401, {}));
    await expect(createCustomReward('bc1', 'user-token', input)).rejects.toBeInstanceOf(TwitchRewardAuthError);
  });

  it('throws a generic error for other non-OK statuses', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(500, {}));
    await expect(createCustomReward('bc1', 'user-token', input)).rejects.toThrow('createCustomReward failed: 500');
  });

  it('throws when a 200 response carries no reward', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: [] }));
    await expect(createCustomReward('bc1', 'user-token', input)).rejects.toThrow('createCustomReward returned empty data');
  });
});

describe('updateCustomReward', () => {
  it('sends a PATCH with broadcaster_id and id query params and the partial input as the body, returning the updated reward', async () => {
    const updated = { id: 'rwd1', title: 'New Title' };
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: [updated] }));

    const result = await updateCustomReward('bc1', 'rwd1', 'user-token', { title: 'New Title' });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toContain('broadcaster_id=bc1');
    expect(String(url)).toContain('id=rwd1');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ title: 'New Title' }));
    expect(result).toEqual(updated);
  });

  it('throws when a 200 response carries no reward', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: [] }));
    await expect(updateCustomReward('bc1', 'rwd1', 'user-token', { title: 'x' })).rejects.toThrow('updateCustomReward returned empty data');
  });

  it('throws TwitchRewardUnsupportedError on a 403 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(403, {}));
    await expect(updateCustomReward('bc1', 'rwd1', 'user-token', { title: 'x' })).rejects.toBeInstanceOf(TwitchRewardUnsupportedError);
  });

  it('throws TwitchRewardAuthError on a 401 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(401, {}));
    await expect(updateCustomReward('bc1', 'rwd1', 'user-token', { title: 'x' })).rejects.toBeInstanceOf(TwitchRewardAuthError);
  });

  it('throws a generic error for other non-OK statuses', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(500, {}));
    await expect(updateCustomReward('bc1', 'rwd1', 'user-token', { title: 'x' })).rejects.toThrow('updateCustomReward failed: 500');
  });
});

describe('updateRedemptionStatus', () => {
  it('sends a PATCH scoped to the broadcaster, reward and redemption with the new status', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: [] }));
    await updateRedemptionStatus('bc1', 'rwd1', 'red1', 'CANCELED', 'user-token');

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toBe('https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=bc1&reward_id=rwd1&id=red1');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ status: 'CANCELED' }));
  });

  it.each([
    [404, TwitchRedemptionNotFoundError],
    [403, TwitchRewardUnsupportedError],
    [401, TwitchRewardAuthError],
  ])('maps a %i to its typed error', async (status, errorClass) => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(status, {}));
    await expect(updateRedemptionStatus('bc1', 'rwd1', 'red1', 'FULFILLED', 'user-token')).rejects.toBeInstanceOf(errorClass);
  });

  it('throws a plain error for any other failure', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(500, {}));
    await expect(updateRedemptionStatus('bc1', 'rwd1', 'red1', 'FULFILLED', 'user-token')).rejects.toThrow('updateRedemptionStatus failed: 500');
  });
});

describe('deleteCustomReward', () => {
  it('sends a DELETE with broadcaster_id and id query params', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(204, {}));
    await deleteCustomReward('bc1', 'rwd1', 'user-token');

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toContain('broadcaster_id=bc1');
    expect(String(url)).toContain('id=rwd1');
    expect(init?.method).toBe('DELETE');
  });

  it('throws TwitchRewardUnsupportedError on a 403 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(403, {}));
    await expect(deleteCustomReward('bc1', 'rwd1', 'user-token')).rejects.toBeInstanceOf(TwitchRewardUnsupportedError);
  });

  it('throws TwitchRewardAuthError on a 401 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(401, {}));
    await expect(deleteCustomReward('bc1', 'rwd1', 'user-token')).rejects.toBeInstanceOf(TwitchRewardAuthError);
  });

  it('throws a generic error for other non-OK statuses', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(500, {}));
    await expect(deleteCustomReward('bc1', 'rwd1', 'user-token')).rejects.toThrow('deleteCustomReward failed: 500');
  });
});
