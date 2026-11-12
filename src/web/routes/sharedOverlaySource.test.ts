import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  getAllStreamersWithGroups: vi.fn(async () => ['alice', 'bob'].map((twitch_name) => ({ twitch_name }))),
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

import express from 'express';
import supertest from 'supertest';
import { getReadinessSnapshot, resetReadiness } from './sharedOverlayReadiness';
import router, {
  sharedConnections, broadcastSharedEvent, pushSharedPlay, getSharedOverlayConnectionCount,
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
  const connect = async (login = 'alice') => handler('/:login/events')(fake(login).req, fake(login).res, vi.fn());
  const post = (login: string, body: unknown) => supertest(app()).post(`/${login}/report`).send(body as object);

  it('records a report from a connected overlay', async () => {
    await connect();
    const res = await post('alice', { stored: [1], downloading: null });
    expect(res.status).toBe(204);
    expect(getReadinessSnapshot([{ id: 1, name: 'Clap' }], new Set(['alice'])).overlays[0]).toMatchObject({ stored: 1 });
  });

  it('is case-insensitive about the login', async () => {
    await connect();
    expect((await post('ALICE', { stored: [], downloading: null })).status).toBe(204);
  });

  it('refuses a login with no connected overlay, and malformed or reserved logins', async () => {
    expect((await post('alice', { stored: [] })).status).toBe(404);
    expect((await post('settings', { stored: [] })).status).toBe(404);
    expect((await post('not-valid!', { stored: [] })).status).toBe(404);
  });

  it('refuses ids that are not on the current list and malformed bodies', async () => {
    await connect();
    expect((await post('alice', { stored: [99] })).status).toBe(400);
    expect((await post('alice', { stored: 'x' })).status).toBe(400);
    expect(getReadinessSnapshot([{ id: 1, name: 'Clap' }], new Set(['alice'])).overlays[0]!.reportedAt).toBeNull();
  });

  it('answers 500 when the list cannot be read', async () => {
    await connect();
    listEnabledSharedVideos.mockRejectedValueOnce(new Error('db'));
    expect((await post('alice', { stored: [] })).status).toBe(500);
  });
});
