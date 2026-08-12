import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../shared/config', () => ({
  TWITCH_CLIENT_ID: 'test-client-id',
  TWITCH_CLIENT_SECRET: 'test-client-secret',
}));

import {
  getUsers, getStreams, getChannelInfo, getSharedChatSession, getAppToken,
  getCustomRewards, updateRewardCost, createCustomReward, updateCustomReward, deleteCustomReward,
  getRewardRedemptions,
  TwitchRewardUnsupportedError, TwitchRewardAuthError,
} from './twitchApi';

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

describe('getAppToken', () => {
  it('uses the cached token without re-fetching', async () => {
    await getAppToken();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('re-fetches after a 401 clears the cache', async () => {
    // 401 on a helix call clears the cached token
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(401, {}));
    await expect(getUsers(['x'])).rejects.toThrow('getUsers failed: 401');

    // Token is now cleared — next getAppToken should fetch a new one
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, TOKEN_RESPONSE));
    await getAppToken();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // 401 helix + token re-fetch
  });
});

describe('getUsers', () => {
  it('returns an empty array for an empty login list without fetching', async () => {
    expect(await getUsers([])).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns mapped user objects for a successful response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse(200, { data: [{ login: 'streamer', id: 'u1' }] }),
    );
    expect(await getUsers(['streamer'])).toEqual([{ login: 'streamer', id: 'u1' }]);
  });

  it('throws on a non-401 error response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(500, {}));
    await expect(getUsers(['x'])).rejects.toThrow('getUsers failed: 500');
  });

  it('chunks logins into batches of 100 and merges results', async () => {
    const logins = Array.from({ length: 150 }, (_, i) => `user${i}`);
    const batch1 = logins.slice(0, 100).map((l) => ({ login: l, id: l }));
    const batch2 = logins.slice(100).map((l) => ({ login: l, id: l }));

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(mockResponse(200, { data: batch1 }))
      .mockResolvedValueOnce(mockResponse(200, { data: batch2 }));

    const result = await getUsers(logins);
    expect(result).toHaveLength(150);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // 2 batches, no token fetch
  });
});

describe('fetchHelixWithRetry — 429 rate limiting', () => {
  it('retries after a 429 and returns the successful result', async () => {
    vi.useFakeTimers();

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        mockResponse(429, {}, { 'ratelimit-reset': String(Math.floor(Date.now() / 1000)) }),
      )
      .mockResolvedValueOnce(mockResponse(200, { data: [{ login: 'a', id: '1' }] }));

    const promise = getUsers(['a']);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual([{ login: 'a', id: '1' }]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // 429 + retry

    vi.useRealTimers();
  });
});

describe('getStreams', () => {
  it('returns an empty array for an empty id list', async () => {
    expect(await getStreams([])).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns stream data on success', async () => {
    const stream = { user_id: 'u1', user_login: 'streamer', game_name: 'Chess', title: 'Playing', thumbnail_url: '', type: 'live' };
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: [stream] }));
    expect(await getStreams(['u1'])).toEqual([stream]);
  });
});

describe('getChannelInfo', () => {
  it('returns an empty array for an empty id list', async () => {
    expect(await getChannelInfo([])).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('getSharedChatSession', () => {
  it('returns null on a 404 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(404, {}));
    expect(await getSharedChatSession('u1')).toBeNull();
  });

  it('returns null on a 403 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(403, {}));
    expect(await getSharedChatSession('u1')).toBeNull();
  });

  it('returns the first session object on a 200 response', async () => {
    const session = { session_id: 's1', host_broadcaster_id: 'u1', participants: [] };
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: [session] }));
    expect(await getSharedChatSession('u1')).toMatchObject({ session_id: 's1' });
  });

  it('returns null when the data array is empty', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: [] }));
    expect(await getSharedChatSession('u1')).toBeNull();
  });

  it('throws and clears the token cache on a 401 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(401, {}));
    await expect(getSharedChatSession('u1')).rejects.toThrow('getSharedChatSession failed: 401');

    // Token cleared — next getAppToken re-fetches
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, TOKEN_RESPONSE));
    await getAppToken();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('getCustomRewards', () => {
  it('sends a GET with the broadcaster_id query param, returning the reward list', async () => {
    const rewards = [{ id: 'rwd1', title: 'Cool Reward', cost: 500 }];
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: rewards }));

    const result = await getCustomRewards('bc1', 'user-token');

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toContain('broadcaster_id=bc1');
    expect(init?.method).toBeUndefined(); // defaults to GET
    expect(result).toEqual(rewards);
  });

  it('throws with the response status on a 401 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(401, {}));
    await expect(getCustomRewards('bc1', 'user-token')).rejects.toThrow('getCustomRewards failed: 401');
  });

  it('returns an empty array on a 403 response, rather than throwing', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(403, {}));
    expect(await getCustomRewards('bc1', 'user-token')).toEqual([]);
  });

  it('throws a generic error for other non-OK statuses', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(500, {}));
    await expect(getCustomRewards('bc1', 'user-token')).rejects.toThrow('getCustomRewards failed: 500');
  });
});

describe('getRewardRedemptions', () => {
  it('sends a GET with broadcaster_id, reward_id, and status query params, returning the redemption page', async () => {
    const redemptions = [{ id: 'redemp1', user_login: 'viewer1', status: 'UNFULFILLED' }];
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: redemptions, pagination: { cursor: 'next-page' } }));

    const result = await getRewardRedemptions('bc1', 'rwd1', 'UNFULFILLED', 'user-token');

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
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

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
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
});

describe('updateRewardCost', () => {
  it('sends a PATCH with broadcaster_id and id query params and the new cost in the body', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: [{ id: 'rwd1', cost: 500 }] }));
    await updateRewardCost('bc1', 'rwd1', 500, 'user-token');

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
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

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
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
});

describe('updateCustomReward', () => {
  it('sends a PATCH with broadcaster_id and id query params and the partial input as the body, returning the updated reward', async () => {
    const updated = { id: 'rwd1', title: 'New Title' };
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { data: [updated] }));

    const result = await updateCustomReward('bc1', 'rwd1', 'user-token', { title: 'New Title' });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toContain('broadcaster_id=bc1');
    expect(String(url)).toContain('id=rwd1');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ title: 'New Title' }));
    expect(result).toEqual(updated);
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

describe('deleteCustomReward', () => {
  it('sends a DELETE with broadcaster_id and id query params', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(204, {}));
    await deleteCustomReward('bc1', 'rwd1', 'user-token');

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
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
