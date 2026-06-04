import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('../shared/config', () => ({
  TWITCH_CLIENT_ID: 'test-client-id',
  TWITCH_CLIENT_SECRET: 'test-client-secret',
}));

import { getUsers, getStreams, getChannelInfo, getSharedChatSession, getAppToken } from './twitchApi';

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
