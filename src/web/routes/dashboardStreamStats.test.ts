import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/config', () => ({
  DASHBOARD_STREAM_STATS_MAX_SSE_PER_USER: 2,
  SSE_MAX_TOTAL_CONNECTIONS: 1000,
}));
vi.mock('../../shared/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../db', () => ({ findUser: vi.fn(), getGuildsForMember: vi.fn() }));
vi.mock('../guildAccess', () => ({ getLiveAccessForRequest: vi.fn() }));

const { middlewareCallOrder } = vi.hoisted(() => ({ middlewareCallOrder: [] as string[] }));
vi.mock('../middleware', () => ({
  requireGuildContext: (_req: any, _res: any, next: any) => { middlewareCallOrder.push('requireGuildContext'); next(); },
}));
// The registry itself is tested in sessionStreams.test.ts; here only that this route hands its stream to it.
vi.mock('../sessionStreams', () => ({
  registerSessionStream: vi.fn(() => true),
  CONTEXT_CHANGED_FRAME: 'event: context-changed\ndata: {}\n\n',
}));

import supertest from 'supertest';
import router, { connections, closeStreamStatsForUser } from './dashboardStreamStats';
import { findUser, getGuildsForMember } from '../../db';
import { getLiveAccessForRequest } from '../guildAccess';
import { registerSessionStream } from '../sessionStreams';
import { recordStreamStatsPoll, resetStreamStatsForTests } from '../../twitch/monitor/streamStatsStore';
import { buildTestApp } from '../../test-utils/expressTestApp';
import type { TwitchStream } from '../../twitch/twitchApi';

/** The route handler for `routePath`, taken from the router's stack, so a test controls the request's `close` event. */
function getRouteHandler(routePath: string): (req: any, res: any, next: any) => Promise<void> {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath);
  return layer.route.stack.at(-1).handle;
}

/** A fake SSE response with the methods the handshake, keepalive and broadcasts use. */
function makeSseRes() {
  return { setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), status: vi.fn().mockReturnThis(), end: vi.fn(), on: vi.fn() };
}

/** A fake request for `discordId` with a `close` hook and a `triggerClose()` helper (which also clears the keepalive timer). */
function makeSseReq(discordId = 'user1') {
  let closeCb: (() => void) | undefined;
  return {
    req: { session: { user: { discordId } }, on: (event: string, cb: () => void) => { if (event === 'close') closeCb = cb; } },
    triggerClose: () => closeCb?.(),
  };
}

/** Makes the live user row (and so the channel) `getLiveAccessForRequest` and `findUser` answer with. */
function setUser(twitchName: string | null, { isOwner = false, guilds = 1 } = {}) {
  const dbUser = { discord_id: 'user1', twitch_name: twitchName, is_owner: isOwner };
  vi.mocked(getLiveAccessForRequest).mockResolvedValue({ dbUser, live: { guilds: [], accessLevelByGuildId: null } } as any);
  vi.mocked(findUser).mockResolvedValue(dbUser as any);
  vi.mocked(getGuildsForMember).mockResolvedValue(Array.from({ length: guilds }, () => ({})) as any);
}

/** A live Helix stream with every field the store keeps. */
function stream(userId: string, overrides: Partial<TwitchStream> = {}): TwitchStream {
  return {
    user_id: userId, user_login: 'x', game_name: 'Just Chatting', title: 'A title', thumbnail_url: '', type: 'live',
    started_at: '2026-11-26T09:00:00Z', viewer_count: 42, ...overrides,
  };
}

/** The JSON payloads written to a fake response as SSE data frames. */
function framesOf(res: ReturnType<typeof makeSseRes>): Record<string, unknown>[] {
  return res.write.mock.calls
    .map((c) => String(c[0]))
    .filter((w) => w.startsWith('data: '))
    .map((w) => JSON.parse(w.slice('data: '.length)));
}

/** Opens a stream for `discordId` through the real handler. */
async function openStream(discordId = 'user1') {
  const res = makeSseRes();
  const { req, triggerClose } = makeSseReq(discordId);
  await getRouteHandler('/stream/events')(req, res, vi.fn());
  return { req, res, triggerClose };
}

beforeEach(() => {
  connections.clear();
  resetStreamStatsForTests();
  vi.clearAllMocks();
  middlewareCallOrder.length = 0;
  setUser('streamer_one');
});

describe('GET /stream/stats', () => {
  const app = () => buildTestApp({ router, sessionUser: { discordId: 'user1' } });

  it('runs requireGuildContext first', async () => {
    await supertest(app()).get('/stream/stats');
    expect(middlewareCallOrder).toEqual(['requireGuildContext']);
  });

  it('answers 403 when the user has no linked Twitch account', async () => {
    setUser(null);
    const res = await supertest(app()).get('/stream/stats');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'no_channel' });
  });

  it('says the channel is not tracked when the monitor has no stats for it, without inventing any field', async () => {
    const res = await supertest(app()).get('/stream/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, tracked: false, serverTime: expect.any(String) });
  });

  it('returns the user\'s own channel stats with the check time and the server time', async () => {
    recordStreamStatsPoll(new Map([['streamer_one', 'u1']]), new Map([['u1', stream('u1')]]));
    const res = await supertest(app()).get('/stream/stats');
    expect(res.body).toEqual({
      ok: true, tracked: true, serverTime: expect.any(String), live: true, title: 'A title', category: 'Just Chatting',
      viewerCount: 42, startedAt: '2026-11-26T09:00:00Z', checkedAt: expect.any(String),
    });
  });

  it('normalises a mixed-case or prefixed linked name to the monitored login', async () => {
    setUser('Streamer_One');
    recordStreamStatsPoll(new Map([['streamer_one', 'u1']]), new Map());
    expect((await supertest(app()).get('/stream/stats')).body.tracked).toBe(true);
  });

  it('never reads another channel: a login in the query string is ignored (two users, two live channels)', async () => {
    recordStreamStatsPoll(
      new Map([['streamer_one', 'u1'], ['streamer_two', 'u2']]),
      new Map([['u1', stream('u1', { viewer_count: 1 })], ['u2', stream('u2', { viewer_count: 99 })]]),
    );
    const res = await supertest(app()).get('/stream/stats?login=streamer_two&channel=streamer_two');
    expect(res.body.viewerCount).toBe(1);
  });

  it('answers 500 when the lookup fails', async () => {
    vi.mocked(getLiveAccessForRequest).mockRejectedValue(new Error('db down'));
    const res = await supertest(app()).get('/stream/stats');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false });
  });
});

describe('GET /stream/events', () => {
  it('runs requireGuildContext first', async () => {
    await supertest(buildTestApp({ router, sessionUser: { discordId: 'user1' } })).get('/stream/events').timeout(200).catch(() => undefined);
    expect(middlewareCallOrder[0]).toBe('requireGuildContext');
  });

  it('answers 403 and opens nothing for a user with no linked Twitch account', async () => {
    setUser(null);
    const res = makeSseRes();
    await getRouteHandler('/stream/events')(makeSseReq().req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(connections.size).toBe(0);
  });

  it('answers 500 when the channel lookup fails', async () => {
    vi.mocked(getLiveAccessForRequest).mockRejectedValue(new Error('db down'));
    const res = makeSseRes();
    await getRouteHandler('/stream/events')(makeSseReq().req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(connections.size).toBe(0);
  });

  it('attaches by user, registers with the session registry before the access re-check, then sends the first snapshot', async () => {
    const order: string[] = [];
    vi.mocked(registerSessionStream).mockImplementationOnce(() => { order.push('register'); return true; });
    vi.mocked(findUser).mockImplementationOnce(async () => { order.push('access check'); return { discord_id: 'user1', twitch_name: 'streamer_one', is_owner: false } as any; });
    recordStreamStatsPoll(new Map([['streamer_one', 'u1']]), new Map([['u1', stream('u1')]]));

    const { req, res, triggerClose } = await openStream();

    expect(registerSessionStream).toHaveBeenCalledWith(req, res, 'stats');
    expect(order).toEqual(['register', 'access check']);
    expect(connections.get('user1')?.has(res as any)).toBe(true);
    expect(framesOf(res)).toEqual([expect.objectContaining({ tracked: true, live: true, viewerCount: 42 })]);
    triggerClose();
  });

  it('sends nothing, not even a poll push, until the access re-check has passed', async () => {
    let finishCheck!: (user: unknown) => void;
    vi.mocked(findUser).mockImplementationOnce(() => new Promise((resolve) => { finishCheck = resolve as any; }));
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq();
    const opening = getRouteHandler('/stream/events')(req, res, vi.fn());
    await vi.waitFor(() => expect(finishCheck).toBeDefined());

    recordStreamStatsPoll(new Map([['streamer_one', 'u1']]), new Map([['u1', stream('u1')]]));
    expect(framesOf(res)).toEqual([]);

    finishCheck({ discord_id: 'user1', twitch_name: 'streamer_one', is_owner: false });
    await opening;
    expect(framesOf(res)).toHaveLength(1);
    triggerClose();
  });

  it.each([
    ['the user row is gone', () => vi.mocked(findUser).mockResolvedValueOnce(null)],
    ['the linked channel changed', () => vi.mocked(findUser).mockResolvedValueOnce({ discord_id: 'user1', twitch_name: 'someone_else', is_owner: false } as any)],
    ['the user left their last guild', () => vi.mocked(getGuildsForMember).mockResolvedValueOnce([])],
    ['the re-check fails', () => vi.mocked(findUser).mockRejectedValueOnce(new Error('db down'))],
  ])('ends the stream without sending anything when %s', async (_name, arrange) => {
    arrange();
    const { res, triggerClose } = await openStream();
    expect(res.end).toHaveBeenCalled();
    expect(framesOf(res)).toEqual([]);
    triggerClose();
  });

  it('lets the bot owner keep a stream with no guild', async () => {
    setUser('streamer_one', { isOwner: true, guilds: 0 });
    const { res, triggerClose } = await openStream();
    expect(res.end).not.toHaveBeenCalled();
    expect(framesOf(res)).toHaveLength(1);
    triggerClose();
  });

  it('stops without a re-check when the registry refuses the stream (its session already ended)', async () => {
    vi.mocked(registerSessionStream).mockReturnValueOnce(false);
    const { res, triggerClose } = await openStream();
    expect(findUser).not.toHaveBeenCalled();
    expect(framesOf(res)).toEqual([]);
    triggerClose();
  });

  it('answers 429 over the per-user limit, and registers nothing for the refused stream', async () => {
    const open = [await openStream(), await openStream()];
    vi.mocked(registerSessionStream).mockClear();
    const refused = await openStream();
    expect(refused.res.status).toHaveBeenCalledWith(429);
    expect(registerSessionStream).not.toHaveBeenCalled();
    for (const o of open) o.triggerClose();
  });

  it('removes the stream when the request closes', async () => {
    const { triggerClose } = await openStream();
    expect(connections.get('user1')?.size).toBe(1);
    triggerClose();
    expect(connections.get('user1')).toBeUndefined();
  });
});

describe('pushes after each poll', () => {
  it('sends each verified stream the stats of its own channel only (two users, two live channels)', async () => {
    setUser('streamer_one');
    const one = await openStream('user1');
    setUser('streamer_two');
    vi.mocked(findUser).mockResolvedValue({ discord_id: 'user2', twitch_name: 'streamer_two', is_owner: false } as any);
    vi.mocked(getLiveAccessForRequest).mockResolvedValue({ dbUser: { discord_id: 'user2', twitch_name: 'streamer_two', is_owner: false }, live: { guilds: [] } } as any);
    const two = await openStream('user2');
    one.res.write.mockClear();
    two.res.write.mockClear();

    recordStreamStatsPoll(
      new Map([['streamer_one', 'u1'], ['streamer_two', 'u2']]),
      new Map([['u1', stream('u1', { viewer_count: 1 })], ['u2', stream('u2', { viewer_count: 99 })]]),
    );

    expect(framesOf(one.res)).toEqual([expect.objectContaining({ viewerCount: 1 })]);
    expect(framesOf(two.res)).toEqual([expect.objectContaining({ viewerCount: 99 })]);
    one.triggerClose();
    two.triggerClose();
  });

  it('sends nothing to a stream whose channel the poll did not check', async () => {
    const { res, triggerClose } = await openStream();
    res.write.mockClear();
    recordStreamStatsPoll(new Map([['streamer_two', 'u2']]), new Map());
    expect(framesOf(res)).toEqual([]);
    triggerClose();
  });

  it('sends every one of the user\'s streams the push, each once', async () => {
    const a = await openStream();
    const b = await openStream();
    a.res.write.mockClear();
    b.res.write.mockClear();
    recordStreamStatsPoll(new Map([['streamer_one', 'u1']]), new Map());
    expect(framesOf(a.res)).toHaveLength(1);
    expect(framesOf(b.res)).toHaveLength(1);
    a.triggerClose();
    b.triggerClose();
  });
});

describe('closeStreamStatsForUser', () => {
  it('tells the user\'s streams to reload and ends them, leaving other users\' streams open', async () => {
    const mine = await openStream('user1');
    vi.mocked(findUser).mockResolvedValue({ discord_id: 'user2', twitch_name: 'streamer_one', is_owner: false } as any);
    const other = await openStream('user2');

    closeStreamStatsForUser('user1');

    expect(mine.res.write).toHaveBeenCalledWith('event: context-changed\ndata: {}\n\n');
    expect(mine.res.end).toHaveBeenCalled();
    expect(other.res.end).not.toHaveBeenCalled();
    mine.triggerClose();
    other.triggerClose();
  });

  it('does nothing for a user with no open stream, and survives a response that throws', async () => {
    expect(() => closeStreamStatsForUser('nobody')).not.toThrow();
    const { res, triggerClose } = await openStream();
    res.end.mockImplementation(() => { throw new Error('broken pipe'); });
    expect(() => closeStreamStatsForUser('user1')).not.toThrow();
    triggerClose();
  });
});
