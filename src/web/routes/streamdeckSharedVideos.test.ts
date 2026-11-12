import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../middleware', () => ({
  requireApiKey: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer key') { res.status(401).json({ ok: false }); return; }
    next();
  },
}));
vi.mock('../../db', () => ({ getSharedVideo: vi.fn(), listEnabledSharedVideos: vi.fn() }));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({
  SHARED_OVERLAY_LEAD_MS: 4000,
  SHARED_OVERLAY_TRIGGER_COOLDOWN_MS: 3000,
}));
vi.mock('./sharedOverlaySource', () => ({
  pushSharedPlay: vi.fn(),
  sharedVideoUrl: (f: string) => `/overlay/shared/videos/${f}`,
}));

import supertest from 'supertest';
import router, { resetSharedVideoCooldown } from './streamdeckSharedVideos';
import { getSharedVideo, listEnabledSharedVideos } from '../../db';
import { pushSharedPlay } from './sharedOverlaySource';
import { buildTestApp } from '../../test-utils/expressTestApp';

const app = () => buildTestApp({ router, bodyParser: 'json' });
const auth = { Authorization: 'Bearer key' };
const video = { id: 2, name: 'Clap', filename: 'a.webm', enabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(100_000);
  resetSharedVideoCooldown();
  vi.mocked(getSharedVideo).mockResolvedValue(video as any);
  vi.mocked(pushSharedPlay).mockReturnValue(3);
});
afterEach(() => { vi.useRealTimers(); });

describe('auth', () => {
  it('refuses both routes without a valid API key', async () => {
    await supertest(app()).get('/shared-videos').expect(401);
    await supertest(app()).post('/shared-videos/trigger').send({ videoId: 2 }).expect(401);
    expect(pushSharedPlay).not.toHaveBeenCalled();
  });
});

describe('GET /shared-videos', () => {
  it('lists only id and name of the enabled videos', async () => {
    vi.mocked(listEnabledSharedVideos).mockResolvedValue([video as any]);
    const res = await supertest(app()).get('/shared-videos').set(auth).expect(200);
    expect(res.body).toEqual({ ok: true, videos: [{ id: 2, name: 'Clap' }] });
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
