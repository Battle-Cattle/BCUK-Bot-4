import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({
  TWITCH_CLIENT_ID: 'test-client-id',
  TWITCH_CLIENT_SECRET: 'test-client-secret',
}));
vi.mock('../../db', () => ({
  saveStreamerToken: vi.fn(),
  clearStreamerToken: vi.fn(),
}));
vi.mock('../twitchApi', () => ({
  twitchFetch: vi.fn(),
  authHeaders: vi.fn((token: string) => ({ Authorization: `Bearer ${token}` })),
}));

import { twitchFetch } from '../twitchApi';
import { saveStreamerToken, clearStreamerToken } from '../../db';
import {
  TwitchAuthError,
  getValidToken,
  exchangeCode,
  refreshUserToken,
  getUserFromToken,
  createEventSubSubscription,
  listEventSubSubscriptions,
  deleteEventSubSubscription,
} from './twitchApiEventSub';
import type { DbStreamerEventSub } from '../../db';

function mockFetch(status: number, body: unknown, textBody?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(textBody ?? JSON.stringify(body)),
  } as unknown as Response;
}

function makeStreamer(overrides: Partial<DbStreamerEventSub> = {}): DbStreamerEventSub {
  return {
    id: 1,
    discord_id: '100000000000000001',
    twitch_name: 'teststreamer',
    twitch_user_id: 'u123',
    eventsub_access_token: 'valid-access-token',
    eventsub_refresh_token: 'valid-refresh-token',
    eventsub_token_expiry: String(Date.now() + 60 * 60 * 1000), // 1 hour from now
    config: null,
    ...overrides,
  };
}

// ─── TwitchAuthError ──────────────────────────────────────────────────────────

describe('TwitchAuthError', () => {
  it('is an instance of Error', () => {
    const err = new TwitchAuthError('bad creds');
    expect(err).toBeInstanceOf(Error);
  });

  it('has name "TwitchAuthError"', () => {
    expect(new TwitchAuthError('x').name).toBe('TwitchAuthError');
  });

  it('preserves the message', () => {
    expect(new TwitchAuthError('bad creds').message).toBe('bad creds');
  });
});

// ─── getValidToken ────────────────────────────────────────────────────────────

describe('getValidToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when eventsub_access_token is null', async () => {
    const streamer = makeStreamer({ eventsub_access_token: null });
    expect(await getValidToken(streamer)).toBeNull();
  });

  it('returns the existing token when it is not near expiry', async () => {
    const streamer = makeStreamer();
    const token = await getValidToken(streamer);
    expect(token).toBe('valid-access-token');
    expect(twitchFetch).not.toHaveBeenCalled();
  });

  it('returns the existing token when expiry is null (no expiry set)', async () => {
    const streamer = makeStreamer({ eventsub_token_expiry: null });
    const token = await getValidToken(streamer);
    expect(token).toBe('valid-access-token');
  });

  it('refreshes the token when it is within the 5-minute buffer', async () => {
    const streamer = makeStreamer({
      eventsub_token_expiry: String(Date.now() + 2 * 60 * 1000), // 2 min — inside buffer
    });
    vi.mocked(twitchFetch).mockResolvedValue(
      mockFetch(200, { access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600 }),
    );
    const token = await getValidToken(streamer);
    expect(token).toBe('new-token');
    expect(saveStreamerToken).toHaveBeenCalledWith(1, 'u123', 'new-token', 'new-refresh', expect.any(Number));
  });

  it('returns null and calls clearStreamerToken when refresh fails with TwitchAuthError', async () => {
    const streamer = makeStreamer({
      eventsub_token_expiry: String(Date.now() + 1 * 60 * 1000),
    });
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(401, {}));
    const token = await getValidToken(streamer);
    expect(token).toBeNull();
    expect(clearStreamerToken).toHaveBeenCalledWith(1);
  });

  it('returns null (no clearStreamerToken) on transient refresh error', async () => {
    const streamer = makeStreamer({
      eventsub_token_expiry: String(Date.now() + 1 * 60 * 1000),
    });
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(503, {}));
    const token = await getValidToken(streamer);
    expect(token).toBeNull();
    expect(clearStreamerToken).not.toHaveBeenCalled();
  });

  it('returns null when token needs refresh but no refresh_token is stored', async () => {
    const streamer = makeStreamer({
      eventsub_token_expiry: String(Date.now() + 1 * 60 * 1000),
      eventsub_refresh_token: null,
    });
    const token = await getValidToken(streamer);
    expect(token).toBeNull();
    expect(twitchFetch).not.toHaveBeenCalled();
  });
});

// ─── exchangeCode ─────────────────────────────────────────────────────────────

describe('exchangeCode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns tokens on a 200 response', async () => {
    const body = { access_token: 'at', refresh_token: 'rt', expires_in: 3600 };
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(200, body));
    const tokens = await exchangeCode('code123', 'https://example.com/callback');
    expect(tokens).toEqual(body);
  });

  it('throws on a non-200 response', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(400, {}));
    await expect(exchangeCode('bad-code', 'https://example.com/callback')).rejects.toThrow(
      'exchangeCode failed: 400',
    );
  });
});

// ─── refreshUserToken ─────────────────────────────────────────────────────────

describe('refreshUserToken', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns tokens on a 200 response', async () => {
    const body = { access_token: 'at2', refresh_token: 'rt2', expires_in: 7200 };
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(200, body));
    const tokens = await refreshUserToken('rt');
    expect(tokens).toEqual(body);
  });

  it('throws TwitchAuthError on a 400 response', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(400, {}));
    await expect(refreshUserToken('expired-rt')).rejects.toThrow(TwitchAuthError);
  });

  it('throws TwitchAuthError on a 401 response', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(401, {}));
    await expect(refreshUserToken('revoked-rt')).rejects.toThrow(TwitchAuthError);
  });

  it('throws a generic Error on a 500 response', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(500, {}));
    const err = await refreshUserToken('rt').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TwitchAuthError);
  });
});

// ─── getUserFromToken ─────────────────────────────────────────────────────────

describe('getUserFromToken', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns id and login on a 200 response', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(
      mockFetch(200, { user_id: 'u999', login: 'mystreamer' }),
    );
    const result = await getUserFromToken('tok');
    expect(result).toEqual({ id: 'u999', login: 'mystreamer' });
  });

  it('returns null for a 401 response', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(401, {}));
    expect(await getUserFromToken('invalid-tok')).toBeNull();
  });

  it('returns null for a 400 response', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(400, {}));
    expect(await getUserFromToken('malformed')).toBeNull();
  });

  it('throws a generic Error on other non-ok responses', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(503, {}));
    await expect(getUserFromToken('tok')).rejects.toThrow('getUserFromToken failed: 503');
  });
});

// ─── createEventSubSubscription ──────────────────────────────────────────────

describe('createEventSubSubscription', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the subscription ID on a 200 response', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(
      mockFetch(200, { data: [{ id: 'sub-abc' }] }),
    );
    const id = await createEventSubSubscription('channel.follow', '1', { broadcaster_user_id: 'u1' }, 'session1', 'token');
    expect(id).toBe('sub-abc');
  });

  it('returns null on 409 (already exists)', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(409, {}));
    const id = await createEventSubSubscription('channel.follow', '1', {}, 'session1', 'token');
    expect(id).toBeNull();
  });

  it('throws TwitchAuthError on 401', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(401, {}, 'Unauthorized'));
    await expect(
      createEventSubSubscription('channel.follow', '1', {}, 'session1', 'token'),
    ).rejects.toThrow(TwitchAuthError);
  });

  it('throws TwitchAuthError on 403', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(403, {}, 'Forbidden'));
    await expect(
      createEventSubSubscription('channel.follow', '1', {}, 'session1', 'token'),
    ).rejects.toThrow(TwitchAuthError);
  });

  it('throws a generic Error on 500', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(500, {}, 'Server Error'));
    const err = await createEventSubSubscription('channel.follow', '1', {}, 'session1', 'token').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TwitchAuthError);
  });

  it('throws when the response data array is empty', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(200, { data: [] }));
    await expect(
      createEventSubSubscription('channel.follow', '1', {}, 'session1', 'token'),
    ).rejects.toThrow('returned empty data');
  });
});

// ─── listEventSubSubscriptions ────────────────────────────────────────────────

describe('listEventSubSubscriptions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns an empty array when data is empty', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(200, { data: [] }));
    const result = await listEventSubSubscriptions('token');
    expect(result).toEqual([]);
  });

  it('returns subscription objects from data', async () => {
    const subs = [{ id: 's1', type: 'channel.follow' }, { id: 's2', type: 'channel.update' }];
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(200, { data: subs }));
    const result = await listEventSubSubscriptions('token');
    expect(result).toEqual(subs);
  });

  it('paginates when a cursor is present', async () => {
    vi.mocked(twitchFetch)
      .mockResolvedValueOnce(mockFetch(200, { data: [{ id: 's1', type: 't1' }], pagination: { cursor: 'cursor1' } }))
      .mockResolvedValueOnce(mockFetch(200, { data: [{ id: 's2', type: 't2' }] }));
    const result = await listEventSubSubscriptions('token');
    expect(result).toHaveLength(2);
    expect(twitchFetch).toHaveBeenCalledTimes(2);
  });

  it('passes userId as query param when provided', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(200, { data: [] }));
    await listEventSubSubscriptions('token', 'u123');
    const [[url]] = vi.mocked(twitchFetch).mock.calls;
    expect(url).toContain('user_id=u123');
  });

  it('throws on a non-ok response', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(500, {}));
    await expect(listEventSubSubscriptions('token')).rejects.toThrow('listEventSubSubscriptions failed: 500');
  });
});

// ─── deleteEventSubSubscription ──────────────────────────────────────────────

describe('deleteEventSubSubscription', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves without throwing on a 204 response', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(204, null));
    await expect(deleteEventSubSubscription('sub-id', 'token')).resolves.toBeUndefined();
  });

  it('resolves without throwing on 404 (already deleted)', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(404, {}));
    await expect(deleteEventSubSubscription('sub-id', 'token')).resolves.toBeUndefined();
  });

  it('throws on other non-ok responses', async () => {
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(500, {}));
    await expect(deleteEventSubSubscription('sub-id', 'token')).rejects.toThrow(
      'deleteEventSubSubscription failed: 500',
    );
  });
});
