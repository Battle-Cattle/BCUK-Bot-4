import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../twitchApi', () => ({
  twitchFetch: vi.fn(),
  authHeaders: vi.fn((token: string) => ({ Authorization: `Bearer ${token}` })),
}));
vi.mock('../twitchUserTokens', () => ({
  TwitchAuthError: class TwitchAuthError extends Error {},
}));

import { twitchFetch } from '../twitchApi';
import { TwitchAuthError } from '../twitchUserTokens';
import {
  createEventSubSubscription,
  listEventSubSubscriptions,
  deleteEventSubSubscription,
} from './twitchApiEventSub';

function mockFetch(status: number, body: unknown, textBody?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(textBody ?? JSON.stringify(body)),
  } as unknown as Response;
}

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
    const err = await createEventSubSubscription('channel.follow', '1', {}, 'session1', 'token').catch((e: unknown) => e);
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

  it('preserves each subscription\'s condition and transport session id in the mapped result', async () => {
    const apiResponse = [
      {
        id: 's1', type: 'channel.follow',
        condition: { broadcaster_user_id: 'uid-1', moderator_user_id: 'uid-1' },
        transport: { method: 'websocket', session_id: 'sess-1' },
      },
      {
        id: 's2', type: 'channel.raid',
        condition: { to_broadcaster_user_id: 'uid-1' },
        // No transport.session_id (e.g. webhook transport, or the field simply absent).
        transport: { method: 'websocket' },
      },
    ];
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(200, { data: apiResponse }));

    const result = await listEventSubSubscriptions('token');

    expect(result).toEqual([
      { id: 's1', type: 'channel.follow', condition: { broadcaster_user_id: 'uid-1', moderator_user_id: 'uid-1' }, sessionId: 'sess-1' },
      { id: 's2', type: 'channel.raid', condition: { to_broadcaster_user_id: 'uid-1' }, sessionId: undefined },
    ]);
  });

  it('preserves each subscription\'s Twitch status in the mapped result', async () => {
    const apiResponse = [
      { id: 's1', type: 'channel.follow', condition: {}, status: 'enabled' },
      { id: 's2', type: 'channel.follow', condition: {}, status: 'authorization_revoked' },
    ];
    vi.mocked(twitchFetch).mockResolvedValue(mockFetch(200, { data: apiResponse }));

    const result = await listEventSubSubscriptions('token');

    expect(result[0]!.status).toBe('enabled');
    expect(result[1]!.status).toBe('authorization_revoked');
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
    const [url] = vi.mocked(twitchFetch).mock.calls[0]!;
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
