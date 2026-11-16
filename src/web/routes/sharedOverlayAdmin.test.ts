import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

const calls: string[] = [];
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({ OVERLAY_MAX_FILE_MB: 100, PUBLIC_URL: 'https://bot.example', OVERLAY_FOLDER: '/o' }));
vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => { req.csrfToken = () => 'tok'; next(); },
}));
// The real chain's order is what matters: guild context must run before the level check.
vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => { calls.push('auth'); next(); },
  requireGuildContext: (_req: any, _res: any, next: any) => { calls.push('guild'); next(); },
  requireManager: (req: any, res: any, next: any) => {
    calls.push('manager');
    if (req.headers['x-level'] === 'mod') { res.status(403).end(); return; }
    next();
  },
}));
vi.mock('../session', () => ({ getSessionUser: () => ({ discordId: 'u1' }) }));
vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(), getVideosForStreamer: vi.fn(), listSharedVideos: vi.fn(),
  getSharedVideo: vi.fn(), removeSharedVideo: vi.fn(), renameSharedVideo: vi.fn(), setSharedVideoEnabled: vi.fn(),
}));
vi.mock('./sharedOverlaySource', () => ({ getSharedOverlayConnectionCount: () => 4, broadcastSharedVideoList: vi.fn() }));
vi.mock('./sharedOverlayAdminMutations', async () => ({ router: (await import('express')).Router() }));
vi.mock('./sharedOverlayReadinessStream', async () => {
  const r = (await import('express')).Router();
  r.get('/readiness/events', (_req, res) => { res.end('stream'); });
  return { router: r };
});
vi.mock('./sharedOverlayAdminPush', async () => ({ router: (await import('express')).Router() }));
vi.mock('./sharedOverlayAdminUpload', async () => ({ router: (await import('express')).Router() }));
vi.mock('./overlayConversionProgress', () => ({
  parseUploadId: (v: string) => (v === 'a'.repeat(32) ? v : null),
  getConversionProgress: (key: number, id: string) => (key === 0 && id === 'a'.repeat(32) ? { stage: 'converting', percent: 40 } : undefined),
}));

import supertest from 'supertest';
import router from './sharedOverlayAdmin';
import { getStreamerByDiscordId, getVideosForStreamer, listSharedVideos } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

const app = () => buildTestApp({ router, sessionUser: { discordId: 'u1' }, mockRender: 'spread' });

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  vi.mocked(listSharedVideos).mockResolvedValue([{ id: 1, name: 'Clap' } as any]);
  vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 5 } as any);
  vi.mocked(getVideosForStreamer).mockResolvedValue([{ id: 9, name: 'Mine' } as any]);
});

describe('GET /', () => {
  it('refuses a Mod, after the guild context has run', async () => {
    const res = await supertest(app()).get('/').set('x-level', 'mod');
    expect(res.status).toBe(403);
    expect(calls).toEqual(['auth', 'guild', 'manager']);
  });

  it('renders the videos, the connected count and the Manager\'s own videos', async () => {
    const res = await supertest(app()).get('/?success=video_deleted&error=bogus');
    expect(res.body).toMatchObject({
      view: 'sharedOverlayAdmin', connectedCount: 4, success: 'video_deleted', error: null,
      videos: [{ id: 1 }], ownVideos: [{ id: 9 }],
    });
  });

  it('passes the pushed count from the query, ignoring anything that is not a small number', async () => {
    expect((await supertest(app()).get('/?success=video_pushed&pushed=3')).body.pushedCount).toBe(3);
    expect((await supertest(app()).get('/?pushed=abc')).body.pushedCount).toBe(0);
    expect((await supertest(app()).get('/?pushed=99999')).body.pushedCount).toBe(0);
  });

  it('shows no own videos for a Manager who is not a streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const res = await supertest(app()).get('/');
    expect(res.body.ownVideos).toEqual([]);
    expect(getVideosForStreamer).not.toHaveBeenCalled();
  });

  it('answers 500 when loading fails', async () => {
    vi.mocked(listSharedVideos).mockRejectedValue(new Error('x'));
    const res = await supertest(app()).get('/');
    expect(res.status).toBe(500);
  });
});

describe('GET /progress/:uploadId', () => {
  it('reports a known upload\'s conversion', async () => {
    const res = await supertest(app()).get(`/progress/${'a'.repeat(32)}`);
    expect(res.body).toEqual({ stage: 'converting', percent: 40 });
  });

  it('reports none for an unknown or malformed id', async () => {
    const res = await supertest(app()).get('/progress/zzz');
    expect(res.body).toEqual({ stage: 'none', percent: null });
  });
});

describe('GET /readiness/events', () => {
  it('is Manager only, behind the guild context', async () => {
    const res = await supertest(app()).get('/readiness/events').set('x-level', 'mod');
    expect(res.status).toBe(403);
    expect(calls).toEqual(['auth', 'guild', 'manager']);
  });

  it('is served to a Manager', async () => {
    expect((await supertest(app()).get('/readiness/events')).text).toBe('stream');
  });
});
