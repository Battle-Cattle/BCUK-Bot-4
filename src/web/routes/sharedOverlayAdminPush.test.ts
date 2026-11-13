import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({ SHARED_OVERLAY_PUSH_COOLDOWN_MS: 60000 }));
vi.mock('../csrf', () => ({ csrfProtection: (_r: any, _s: any, next: any) => next() }));
vi.mock('../../db', () => ({ getSharedVideo: vi.fn() }));
const broadcast = vi.fn();
vi.mock('./sharedOverlaySource', () => ({
  broadcastSharedEvent: (...a: unknown[]) => broadcast(...a),
  sharedVideoUrl: (f: string) => `/overlay/shared/videos/${f}`,
}));

import supertest from 'supertest';
import { router, resetPushCooldowns } from './sharedOverlayAdminPush';
import { getSharedVideo } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

const post = (id: string) => supertest(buildTestApp({ router })).post(`/videos/${id}/push`);
const loc = (res: { headers: Record<string, string> }) => res.headers.location;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
  resetPushCooldowns();
  vi.clearAllMocks();
  vi.mocked(getSharedVideo).mockResolvedValue({ id: 3, filename: 'a.webm', enabled: true } as any);
  broadcast.mockReturnValue(4);
});
afterEach(() => { vi.useRealTimers(); });

describe('POST /videos/:id/push', () => {
  it('sends fetchNow with the video URL to every overlay and reports how many were reached', async () => {
    const res = await post('3');
    expect(broadcast).toHaveBeenCalledWith({ type: 'fetchNow', url: '/overlay/shared/videos/a.webm' });
    expect(loc(res)).toBe('/overlay/shared/settings?success=video_pushed&pushed=4');
  });

  it('refuses a bad id, an unknown video and a disabled video without sending anything', async () => {
    expect(loc(await post('x'))).toBe('/overlay/shared/settings?error=invalid_id');
    vi.mocked(getSharedVideo).mockResolvedValueOnce(null);
    expect(loc(await post('3'))).toBe('/overlay/shared/settings?error=not_found');
    vi.mocked(getSharedVideo).mockResolvedValueOnce({ id: 3, filename: 'a.webm', enabled: false } as any);
    expect(loc(await post('3'))).toBe('/overlay/shared/settings?error=video_disabled');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('refuses a second push of the same video inside the cooldown, then allows one after it', async () => {
    await post('3');
    vi.setSystemTime(1_059_999);
    expect(loc(await post('3'))).toBe('/overlay/shared/settings?error=push_cooldown');
    expect(broadcast).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_060_000);
    expect(loc(await post('3'))).toContain('success=video_pushed');
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it('keeps the cooldown per video', async () => {
    await post('3');
    vi.mocked(getSharedVideo).mockResolvedValue({ id: 4, filename: 'b.webm', enabled: true } as any);
    expect(loc(await post('4'))).toContain('success=video_pushed');
  });

  it('redirects with save_failed on a DB error', async () => {
    vi.mocked(getSharedVideo).mockRejectedValue(new Error('db'));
    expect(loc(await post('3'))).toBe('/overlay/shared/settings?error=save_failed');
  });
});
