import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../middleware', () => ({
  requireApiKey: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer key') { res.status(401).json({ ok: false }); return; }
    req.apiKeyOwner = '100000000000000001';
    next();
  },
}));
vi.mock('../../db', () => ({
  getSharedVideo: vi.fn(),
  listEnabledSharedVideos: vi.fn(),
  getApprovedGuildIdsForKey: vi.fn(),
  isKeyApprovedForGuild: vi.fn(),
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({
  SHARED_OVERLAY_LEAD_MS: 4000,
  SHARED_OVERLAY_TRIGGER_COOLDOWN_MS: 3000,
}));
const conns = vi.hoisted(() => ({ sharedConnections: new Map<string, Set<unknown>>() }));
vi.mock('./sharedOverlaySource', () => ({
  sharedConnections: conns.sharedConnections,
  pushSharedPlay: vi.fn(),
  sharedVideoUrl: (f: string) => `/overlay/shared/videos/${f}`,
}));

import supertest from 'supertest';
import router, { resetSharedVideoCooldown } from './streamdeckSharedVideos';
import { getSharedVideo, listEnabledSharedVideos, getApprovedGuildIdsForKey } from '../../db';
import { pushSharedPlay } from './sharedOverlaySource';
import { recordReadinessReport, resetReadiness } from './sharedOverlayReadiness';
import { buildTestApp } from '../../test-utils/expressTestApp';

const app = () => buildTestApp({ router, bodyParser: 'json' });
const auth = { Authorization: 'Bearer key' };
const video = { id: 2, name: 'Clap', filename: 'a.webm', enabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(100_000);
  resetSharedVideoCooldown();
  conns.sharedConnections.clear();
  resetReadiness();
  vi.mocked(getSharedVideo).mockResolvedValue(video as any);
  vi.mocked(pushSharedPlay).mockReturnValue(3);
  vi.mocked(getApprovedGuildIdsForKey).mockResolvedValue(['900000000000000001']);
});
afterEach(() => { vi.useRealTimers(); });

describe('auth', () => {
  it('refuses both routes without a valid API key', async () => {
    await supertest(app()).get('/shared-videos').expect(401);
    await supertest(app()).post('/shared-videos/trigger').send({ videoId: 2 }).expect(401);
    expect(pushSharedPlay).not.toHaveBeenCalled();
  });
});

describe('key approval (#1002)', () => {
  it('refuses both routes with 403 for a key not approved for any guild, without broadcasting or claiming the cooldown', async () => {
    vi.mocked(getApprovedGuildIdsForKey).mockResolvedValue([]);
    vi.mocked(listEnabledSharedVideos).mockResolvedValue([video as any]);

    const list = await supertest(app()).get('/shared-videos').set(auth).expect(403);
    expect(list.body).toEqual({ ok: false, error: 'Key not approved for any guild' });
    const trigger = await supertest(app()).post('/shared-videos/trigger').set(auth).send({ videoId: 2 }).expect(403);
    expect(trigger.body).toEqual({ ok: false, error: 'Key not approved for any guild' });

    expect(getApprovedGuildIdsForKey).toHaveBeenCalledWith('100000000000000001');
    expect(listEnabledSharedVideos).not.toHaveBeenCalled();
    expect(getSharedVideo).not.toHaveBeenCalled();
    expect(pushSharedPlay).not.toHaveBeenCalled();

    // The refused press didn't claim the global cooldown: an approved key can trigger straight away.
    vi.mocked(getApprovedGuildIdsForKey).mockResolvedValue(['900000000000000001']);
    const ok = await supertest(app()).post('/shared-videos/trigger').set(auth).send({ videoId: 2 }).expect(200);
    expect(ok.body).toEqual({ ok: true, triggered: true, reached: 3 });
  });

  it('answers 500 when the approval lookup fails', async () => {
    vi.mocked(getApprovedGuildIdsForKey).mockRejectedValue(new Error('db down'));
    await supertest(app()).get('/shared-videos').set(auth).expect(500);
    await supertest(app()).post('/shared-videos/trigger').set(auth).send({ videoId: 2 }).expect(500);
    expect(pushSharedPlay).not.toHaveBeenCalled();
  });
});

describe('GET /shared-videos', () => {
  it('lists the enabled videos with their id and name, and zero readiness with nobody connected', async () => {
    vi.mocked(listEnabledSharedVideos).mockResolvedValue([video as any]);
    const res = await supertest(app()).get('/shared-videos').set(auth).expect(200);
    expect(res.body).toEqual({ ok: true, videos: [{ id: 2, name: 'Clap', ready: 0, connected: 0 }] });
  });

  it('adds how many connected overlays have each video, matching the admin aggregation', async () => {
    vi.mocked(listEnabledSharedVideos).mockResolvedValue([video as any, { id: 3, name: 'Boo', filename: 'b.webm', enabled: true } as any]);
    ['alice', 'bob', 'carol'].forEach((l) => conns.sharedConnections.set(l, new Set()));
    recordReadinessReport('alice', { stored: [2, 3], downloading: null });
    recordReadinessReport('bob', { stored: [2], downloading: { id: 3, percent: 10 } });
    recordReadinessReport('dave', { stored: [2, 3], downloading: null }); // offline: not counted
    const res = await supertest(app()).get('/shared-videos').set(auth).expect(200);
    expect(res.body.videos).toEqual([
      { id: 2, name: 'Clap', ready: 2, connected: 3 },
      { id: 3, name: 'Boo', ready: 1, connected: 3 },
    ]);
  });

  it('answers 500 on a DB error', async () => {
    vi.mocked(listEnabledSharedVideos).mockRejectedValue(new Error('x'));
    const res = await supertest(app()).get('/shared-videos').set(auth);
    expect(res.status).toBe(500);
  });
});

describe('POST /shared-videos/trigger', () => {
  const post = (body: unknown) => supertest(app()).post('/shared-videos/trigger').set(auth).send(body as object);

  it.each([{}, { videoId: 0 }, { videoId: 'x' }, { videoId: 1.5 }])('400s an invalid id %j', async (body) => {
    await post(body).expect(400);
    expect(pushSharedPlay).not.toHaveBeenCalled();
  });

  it('404s an unknown video', async () => {
    vi.mocked(getSharedVideo).mockResolvedValue(null);
    const res = await post({ videoId: 9 }).expect(404);
    expect(res.body.error).toBe('video_not_found');
  });

  it('404s a disabled video', async () => {
    vi.mocked(getSharedVideo).mockResolvedValue({ ...video, enabled: false } as any);
    await post({ videoId: 2 }).expect(404);
    expect(pushSharedPlay).not.toHaveBeenCalled();
  });

  it('broadcasts the URL with playAt = now + lead and returns the reached count', async () => {
    const res = await post({ videoId: '2' }).expect(200);
    expect(pushSharedPlay).toHaveBeenCalledWith('/overlay/shared/videos/a.webm', 104_000);
    expect(res.body).toEqual({ ok: true, triggered: true, reached: 3 });
  });

  it('ignores a second trigger inside the cooldown, then accepts one after it', async () => {
    await post({ videoId: 2 }).expect(200);
    vi.setSystemTime(102_999);
    const early = await post({ videoId: 2 }).expect(200);
    expect(early.body).toEqual({ ok: true, triggered: false, reason: 'cooldown' });
    expect(pushSharedPlay).toHaveBeenCalledTimes(1);
    vi.setSystemTime(103_000);
    await post({ videoId: 2 }).expect(200);
    expect(pushSharedPlay).toHaveBeenCalledTimes(2);
  });

  it('answers 500 on a DB error', async () => {
    vi.mocked(getSharedVideo).mockRejectedValue(new Error('x'));
    const res = await post({ videoId: 2 });
    expect(res.status).toBe(500);
  });
});
