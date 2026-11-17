import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lastSentLive } from './sharedOverlayLiveState';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({
  OVERLAY_FOLDER: '/app/overlay-videos',
  OVERLAY_MAX_SSE_PER_CHANNEL: 2,
  SHARED_OVERLAY_MAX_LATE_SECONDS: 3,
  SSE_MAX_TOTAL_CONNECTIONS: 1000,
}));

const listEnabledSharedVideos = vi.fn();
vi.mock('../../db', () => ({
  listEnabledSharedVideos: (...a: unknown[]) => listEnabledSharedVideos(...a),
  getStreamerByDiscordId: vi.fn(),
  getAllStreamersWithGroups: vi.fn(async () => ['alice', 'bob', 'livechannel'].map((twitch_name) => ({ twitch_name }))),
  createManagedLookupCache: (opts: { loadCache: () => Promise<unknown> }) => ({ getCache: () => opts.loadCache(), invalidate: () => {} }),
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS: 5000,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS: 60000,
}));
vi.mock('fs', () => ({ default: { readdirSync: () => ['sharedOverlaySource.ejs'] } }));
const servePreload = vi.hoisted(() => vi.fn());
vi.mock('./sharedOverlayPreload', () => ({ servePreloadVideo: servePreload }));
vi.mock('../rateLimits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../rateLimits')>()),
  sharedOverlayReportLimiter: (_q: any, _s: any, next: any) => next(),
}));
vi.mock('../../shared/pathUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/pathUtils')>();
  return {
    safeResolve: vi.fn(actual.safeResolve),
    realPathWithin: vi.fn(async (_b: string, c: string) => c as string | null),
  };
});

import { waitFor } from '../../test-utils/waitFor';
import express from 'express';
import supertest from 'supertest';
import { getReadinessSnapshot, resetReadiness } from './sharedOverlayReadiness';
import { setTwitchChannel, setTwitchChannelLive } from '../../shared/statusStore';
import router, {
  sharedConnections, broadcastSharedEvent, broadcastSharedVideoList, pushSharedPlay, getSharedOverlayConnectionCount,
} from './sharedOverlaySource';

/** Finds a route handler on the router's stack. */
function handler(routePath: string) {
  return (router as any).stack.find((l: any) => l.route?.path === routePath).route.stack[0].handle;
}

/** A fake SSE response/request pair. */
function fake(login: string) {
  const res: any = {
    setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn(),
    status: vi.fn().mockReturnThis(), writableLength: 0, writableEnded: false, closed: false,
  };
  const req: any = { params: { login }, ip: '10.0.0.1', destroyed: false, on: vi.fn() };
  return { req, res };
}

/** Frames written to a fake response, parsed. */
function frames(res: any): any[] {
  return res.write.mock.calls
    .map((c: any[]) => String(c[0]))
    .filter((s: string) => s.startsWith('data: '))
    .map((s: string) => JSON.parse(s.slice(6)));
}

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => {
    (res as any).render = (view: string, locals?: object) => res.json({ view, ...(locals ?? {}) });
    (res as any).sendFile = (p: string) => res.json({ sentFile: p });
    next();
  });
  a.use(router);
  return a;
}

beforeEach(() => {
  sharedConnections.clear();
  resetReadiness();
  vi.clearAllMocks();
  listEnabledSharedVideos.mockResolvedValue([{ id: 1, name: 'Clap', filename: 'a b.webm' }]);
});

describe('page', () => {
  it('renders the shared overlay view with the lowercased login', async () => {
    const res = await supertest(app()).get('/SomeChannel');
    expect(res.body).toMatchObject({ view: 'sharedOverlaySource', login: 'somechannel' });
  });

  it('does not treat "videos" or "settings" as a login', async () => {
    expect((await supertest(app()).get('/settings')).status).toBe(404);
  });
});

describe('events', () => {
  it('sends server time, the late limit and the enabled list on connect', async () => {
    const { req, res } = fake('alice');
    await handler('/:login/events')(req, res, vi.fn());
    const [init] = frames(res);
    expect(init).toMatchObject({
      type: 'init', maxLateMs: 3000,
      videos: [{ id: 1, name: 'Clap', url: '/overlay/shared/videos/a%20b.webm' }],
    });
    expect(typeof init.serverTime).toBe('number');
    expect(getSharedOverlayConnectionCount()).toBe(1);
  });

  it('tells the overlay whether its streamer is live on connect', async () => {
    const offline = fake('alice');
    await handler('/:login/events')(offline.req, offline.res, vi.fn());
    expect(frames(offline.res)[0].live).toBe(false);
    setTwitchChannel('livechannel', true); // Twitch logins are at least 4 characters
    setTwitchChannelLive('livechannel', true);
    const live = fake('livechannel');
    await handler('/:login/events')(live.req, live.res, vi.fn());
    expect(frames(live.res)[0].live).toBe(true);
    expect(lastSentLive.get('livechannel')).toBe(true); // so the first later change is pushed
    expect(lastSentLive.get('alice')).toBe(false);
  });

  it('closes the connection when the list lookup fails', async () => {
    listEnabledSharedVideos.mockRejectedValueOnce(new Error('db down'));
    const { req, res } = fake('alice');
    await handler('/:login/events')(req, res, vi.fn());
    expect(res.end).toHaveBeenCalled();
    expect(frames(res)).toEqual([]);
  });

  it('404s an unregistered login and sends no init', async () => {
    const { req, res } = fake('nobody');
    await handler('/:login/events')(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(sharedConnections.size).toBe(0);
  });

  it('enforces the per-channel limit', async () => {
    for (let i = 0; i < 2; i++) await handler('/:login/events')(fake('alice').req, fake('alice').res, vi.fn());
    const third = fake('alice');
    await handler('/:login/events')(third.req, third.res, vi.fn());
    expect(third.res.status).toHaveBeenCalledWith(429);
    expect(frames(third.res)).toEqual([]);
  });
});

describe('broadcast', () => {
  it('reaches every connected overlay across channels', async () => {
    const a = fake('alice');
    const b = fake('bob');
    await handler('/:login/events')(a.req, a.res, vi.fn());
    await handler('/:login/events')(b.req, b.res, vi.fn());
    expect(pushSharedPlay('/overlay/shared/videos/x.webm', 123)).toBe(2);
    for (const r of [a.res, b.res]) {
      expect(frames(r).at(-1)).toEqual({ type: 'play', video: '/overlay/shared/videos/x.webm', playAt: 123 });
    }
    expect(broadcastSharedEvent({ type: 'x' })).toBe(2);
  });

  it('sends the current enabled list to every overlay when a Manager changes it', async () => {
    const a = fake('alice');
    await handler('/:login/events')(a.req, a.res, vi.fn());
    listEnabledSharedVideos.mockResolvedValue([{ id: 2, name: 'Boo', filename: 'b.webm' }]);
    await expect(broadcastSharedVideoList()).resolves.toBe(1);
    expect(frames(a.res).at(-1)).toEqual({ type: 'videos', videos: [{ id: 2, name: 'Boo', url: '/overlay/shared/videos/b.webm' }] });
  });

  it('sends overlapping list changes in order, so a slow earlier read cannot overwrite a newer list', async () => {
    const a = fake('alice');
    await handler('/:login/events')(a.req, a.res, vi.fn());
    let releaseFirst!: (v: unknown) => void;
    listEnabledSharedVideos
      .mockReturnValueOnce(new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce([{ id: 2, name: 'Newer', filename: 'n.webm' }]);
    const readsBefore = listEnabledSharedVideos.mock.calls.length;
    const first = broadcastSharedVideoList();
    const second = broadcastSharedVideoList();
    await waitFor(() => expect(listEnabledSharedVideos).toHaveBeenCalledTimes(readsBefore + 1));
    // The second change has not read the list yet: it waits for the first send to finish.
    expect(listEnabledSharedVideos).toHaveBeenCalledTimes(readsBefore + 1);
    releaseFirst([{ id: 1, name: 'Older', filename: 'o.webm' }]);
    await Promise.all([first, second]);
    expect(frames(a.res).slice(-2).map((f: any) => f.videos[0].name)).toEqual(['Older', 'Newer']);
  });

  it('still sends the next list change after an earlier one failed', async () => {
    const a = fake('alice');
    await handler('/:login/events')(a.req, a.res, vi.fn());
    listEnabledSharedVideos
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce([{ id: 3, name: 'Next', filename: 'x.webm' }]);
    const failed = broadcastSharedVideoList();
    const next = broadcastSharedVideoList();
    await expect(failed).rejects.toThrow('db down');
    await expect(next).resolves.toBe(1);
    expect((frames(a.res).at(-1) as any).videos[0].name).toBe('Next');
  });

  it('sends no playback to an overlay until its init frame has been written', async () => {
    let release!: (v: unknown) => void;
    listEnabledSharedVideos.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const a = fake('alice');
    const connecting = handler('/:login/events')(a.req, a.res, vi.fn());
    await vi.waitFor(() => expect(sharedConnections.has('alice')).toBe(true));
    pushSharedPlay('/overlay/shared/videos/x.webm', 123);
    expect(frames(a.res)).toEqual([]);
    release([]);
    await connecting;
    pushSharedPlay('/overlay/shared/videos/x.webm', 456);
    expect(frames(a.res).map((f) => f.type)).toEqual(['init', 'play']);
    expect(frames(a.res)[1].playAt).toBe(456);
  });

  it('reaches nobody when none are connected', () => {
    expect(broadcastSharedEvent({ type: 'x' })).toBe(0);
  });
});

describe('GET /videos/:filename', () => {
  it('serves a file from the shared folder', async () => {
    const res = await supertest(app()).get('/videos/a.webm');
    expect(res.body.sentFile).toBe('/app/overlay-videos/shared/a.webm');
  });

  it('serves ?preload=1 through the speed-limited handler, and the plain route at full speed', async () => {
    servePreload.mockImplementation(async (_req: any, res: any) => { res.json({ throttled: true }); });
    expect((await supertest(app()).get('/videos/a.webm?preload=1')).body).toEqual({ throttled: true });
    expect(servePreload).toHaveBeenCalledTimes(1);
    expect((await supertest(app()).get('/videos/a.webm')).body.sentFile).toBe('/app/overlay-videos/shared/a.webm');
    expect(servePreload).toHaveBeenCalledTimes(1);
  });

  it.each(['a.mp4', 'a.txt', '..%2Fx.webm'])('refuses %s', async (name) => {
    const res = await supertest(app()).get(`/videos/${name}`);
    expect([400, 404]).toContain(res.status);
    expect(res.body.sentFile).toBeUndefined();
  });
});

describe('POST /:login/report', () => {
  /** Connects an overlay and returns the report nonce its init frame carried. */
  let ipSuffix = 0;
  const connect = async (login = 'alice'): Promise<string> => {
    const { req, res } = fake(login);
    req.ip = `10.0.1.${++ipSuffix}`; // its own IP, so the per-IP connection cap doesn't refuse a second overlay
    await handler('/:login/events')(req, res, vi.fn());
    return frames(res)[0].reportNonce;
  };
  let nonce = '';
  const post = (login: string, body: unknown, withNonce: string | null = nonce) => {
    const r = supertest(app()).post(`/${login}/report`);
    return (withNonce === null ? r : r.set('X-Shared-Overlay-Nonce', withNonce)).send(body as object);
  };
  const aliceReportedAt = () => getReadinessSnapshot([{ id: 1, name: 'Clap' }], new Set(['alice'])).overlays[0]?.reportedAt;

  it('records a report from a connected overlay', async () => {
    nonce = await connect();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    const res = await post('alice', { stored: [1], downloading: null });
    expect(res.status).toBe(204);
    expect(getReadinessSnapshot([{ id: 1, name: 'Clap' }], new Set(['alice'])).overlays[0]).toMatchObject({ stored: 1 });
  });

  it('is case-insensitive about the login', async () => {
    nonce = await connect();
    expect((await post('ALICE', { stored: [], downloading: null })).status).toBe(204);
  });

  it('refuses a login with no connected overlay, and malformed or reserved logins', async () => {
    expect((await post('alice', { stored: [] })).status).toBe(404);
    expect((await post('settings', { stored: [] })).status).toBe(404);
    expect((await post('not-valid!', { stored: [] })).status).toBe(404);
  });

  it('refuses ids that are not on the current list and malformed bodies', async () => {
    nonce = await connect();
    expect((await post('alice', { stored: [99] })).status).toBe(400);
    expect((await post('alice', { stored: 'x' })).status).toBe(400);
    expect(getReadinessSnapshot([{ id: 1, name: 'Clap' }], new Set(['alice'])).overlays[0]).toMatchObject({ reportedAt: null });
  });

  it('answers 500 when the list cannot be read', async () => {
    nonce = await connect();
    listEnabledSharedVideos.mockRejectedValueOnce(new Error('db'));
    expect((await post('alice', { stored: [] })).status).toBe(500);
  });

  it('refuses a report with no nonce or a malformed one, and records nothing', async () => {
    await connect();
    expect((await post('alice', { stored: [1], downloading: null }, null)).status).toBe(403);
    expect((await post('alice', { stored: [1], downloading: null }, 'not-a-nonce')).status).toBe(403);
    expect(aliceReportedAt()).toBeNull();
  });

  it("refuses another login's nonce", async () => {
    await connect('alice');
    const bobNonce = await connect('bob');
    expect((await post('alice', { stored: [1], downloading: null }, bobNonce)).status).toBe(403);
    expect(aliceReportedAt()).toBeNull();
  });

  it('refuses the nonce of a connection that has closed', async () => {
    const { req, res } = fake('alice');
    req.ip = '10.0.2.1';
    await handler('/:login/events')(req, res, vi.fn());
    const stale = frames(res)[0].reportNonce;
    await connect('alice'); // another overlay keeps the login connected
    sharedConnections.get('alice')!.delete(res); // as the SSE cleanup does on close
    expect((await post('alice', { stored: [1], downloading: null }, stale)).status).toBe(403);
    expect(aliceReportedAt()).toBeNull();
  });

  it('gives each connection its own nonce, and accepts either while both are open', async () => {
    const first = await connect('alice');
    const second = await connect('alice');
    expect(first).not.toBe(second);
    expect((await post('alice', { stored: [], downloading: null }, first)).status).toBe(204);
    expect((await post('alice', { stored: [1], downloading: null }, second)).status).toBe(204);
  });
});
