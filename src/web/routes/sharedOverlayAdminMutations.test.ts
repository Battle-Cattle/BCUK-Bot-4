import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({ OVERLAY_FOLDER: '/o' }));
vi.mock('../csrf', () => ({ csrfProtection: (_r: any, _s: any, next: any) => next() }));
vi.mock('../session', () => ({ getSessionUser: () => ({ discordId: 'u1' }) }));
vi.mock('../../db', () => ({
  removeSharedVideo: vi.fn(), renameSharedVideo: vi.fn(), setSharedVideoEnabled: vi.fn(),
  getStreamerByDiscordId: vi.fn(), getVideosForStreamer: vi.fn(),
}));
vi.mock('../../shared/pathUtils', () => ({
  safeResolve: (...p: string[]) => p.join('/'),
  realPathWithin: vi.fn(async (_b: string, c: string) => c),
}));
vi.mock('fs', () => ({ default: { promises: { copyFile: vi.fn(async () => {}) }, constants: { COPYFILE_EXCL: 1 } } }));
const files = vi.hoisted(() => ({
  storeSharedVideo: vi.fn(), recordSharedVideo: vi.fn(), removeSharedVideoFile: vi.fn(),
}));
vi.mock('./sharedOverlayVideoStorage', () => files);
const transcode = vi.hoisted(() => ({ isWebmTranscodeQueueFull: vi.fn(() => false) }));
vi.mock('./overlayVideoTranscode', () => transcode);
const readiness = vi.hoisted(() => ({ notifyReadinessChange: vi.fn() }));
vi.mock('./sharedOverlayReadiness', () => readiness);
const broadcast = vi.fn();
vi.mock('./sharedOverlaySource', () => ({ broadcastSharedVideoList: (...a: unknown[]) => broadcast(...a) }));

import supertest from 'supertest';
import { router } from './sharedOverlayAdminMutations';
import {
  removeSharedVideo, renameSharedVideo, setSharedVideoEnabled, getStreamerByDiscordId, getVideosForStreamer,
} from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';
import { waitFor } from '../../test-utils/waitFor';

const app = () => buildTestApp({ router, bodyParser: 'urlencoded' });
const post = (url: string, body: object = {}) => supertest(app()).post(url).type('form').send(body);
const loc = (res: { headers: Record<string, string> }) => res.headers.location;

beforeEach(() => {
  vi.clearAllMocks();
  broadcast.mockResolvedValue(2);
  transcode.isWebmTranscodeQueueFull.mockReturnValue(false);
});

describe('rename', () => {
  it('renames, broadcasts and redirects', async () => {
    vi.mocked(renameSharedVideo).mockResolvedValue(true);
    const res = await post('/3/rename', { name: '  New  ' });
    expect(renameSharedVideo).toHaveBeenCalledWith(3, 'New');
    expect(broadcast).toHaveBeenCalled();
    expect(loc(res)).toBe('/overlay/shared/settings?success=video_renamed');
  });

  it.each([
    ['/x/rename', { name: 'a' }, 'invalid_id'],
    ['/3/rename', { name: '   ' }, 'invalid_name'],
  ])('refuses %s', async (url, body, code) => {
    const res = await post(url, body);
    expect(loc(res)).toBe(`/overlay/shared/settings?error=${code}`);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('reports a missing video without broadcasting', async () => {
    vi.mocked(renameSharedVideo).mockResolvedValue(false);
    const res = await post('/3/rename', { name: 'a' });
    expect(loc(res)).toBe('/overlay/shared/settings?error=not_found');
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('database errors', () => {
  it('redirect rename, enable and import failures with save_failed', async () => {
    vi.mocked(renameSharedVideo).mockRejectedValue(new Error('db'));
    expect(loc(await post('/3/rename', { name: 'a' }))).toBe('/overlay/shared/settings?error=save_failed');
    vi.mocked(setSharedVideoEnabled).mockRejectedValue(new Error('db'));
    expect(loc(await post('/3/enabled', { enabled: '1' }))).toBe('/overlay/shared/settings?error=save_failed');
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('db'));
    expect(loc(await post('/import/9'))).toBe('/overlay/shared/settings?error=save_failed');
  });
});

describe('enabled', () => {
  it('enables and disables, each broadcasting the list', async () => {
    vi.mocked(setSharedVideoEnabled).mockResolvedValue(true);
    expect(loc(await post('/3/enabled', { enabled: '1' }))).toBe('/overlay/shared/settings?success=video_enabled');
    expect(loc(await post('/3/enabled', { enabled: '0' }))).toBe('/overlay/shared/settings?success=video_disabled');
    expect(vi.mocked(setSharedVideoEnabled).mock.calls.map((c) => c[1])).toEqual([true, false]);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it('reports a missing video', async () => {
    vi.mocked(setSharedVideoEnabled).mockResolvedValue(false);
    expect(loc(await post('/3/enabled', { enabled: '1' }))).toBe('/overlay/shared/settings?error=not_found');
  });
});

describe('readiness view', () => {
  it('is told about a list change, even when the overlay broadcast fails', async () => {
    vi.mocked(setSharedVideoEnabled).mockResolvedValue(true);
    await post('/3/enabled', { enabled: '1' });
    expect(readiness.notifyReadinessChange).toHaveBeenCalledTimes(1);
    broadcast.mockRejectedValue(new Error('x'));
    await post('/3/enabled', { enabled: '0' });
    expect(readiness.notifyReadinessChange).toHaveBeenCalledTimes(2);
  });
});

describe('delete', () => {
  it('removes the row, then the file, then broadcasts', async () => {
    vi.mocked(removeSharedVideo).mockResolvedValue('a.webm');
    const res = await post('/3/delete');
    expect(files.removeSharedVideoFile).toHaveBeenCalledWith('a.webm');
    expect(broadcast).toHaveBeenCalled();
    expect(loc(res)).toBe('/overlay/shared/settings?success=video_deleted');
  });

  it('reports a missing video and leaves files alone', async () => {
    vi.mocked(removeSharedVideo).mockResolvedValue(null);
    expect(loc(await post('/3/delete'))).toBe('/overlay/shared/settings?error=not_found');
    expect(files.removeSharedVideoFile).not.toHaveBeenCalled();
  });

  it('redirects with delete_failed on a DB error', async () => {
    vi.mocked(removeSharedVideo).mockRejectedValue(new Error('x'));
    expect(loc(await post('/3/delete'))).toBe('/overlay/shared/settings?error=delete_failed');
  });

  it('keeps the broadcast failure from failing the delete', async () => {
    vi.mocked(removeSharedVideo).mockResolvedValue('a.webm');
    broadcast.mockRejectedValue(new Error('x'));
    expect(loc(await post('/3/delete'))).toBe('/overlay/shared/settings?success=video_deleted');
  });
});

describe('import own video', () => {
  beforeEach(() => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 5 } as any);
    vi.mocked(getVideosForStreamer).mockResolvedValue([{ id: 9, name: 'Mine', filename: 'm.mp4' } as any]);
    files.storeSharedVideo.mockResolvedValue('new.webm');
  });

  it('converts a copy, records it with the Manager as uploader and broadcasts', async () => {
    const res = await post('/import/9');
    expect(files.storeSharedVideo).toHaveBeenCalled();
    expect(files.recordSharedVideo).toHaveBeenCalledWith('Mine', 'new.webm', 'u1');
    expect(broadcast).toHaveBeenCalled();
    expect(loc(res)).toBe('/overlay/shared/settings?success=video_added');
  });

  it('refuses a non-streamer, a bad id and someone else\'s video', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValueOnce(null);
    expect(loc(await post('/import/9'))).toBe('/overlay/shared/settings?error=not_a_streamer');
    expect(loc(await post('/import/x'))).toBe('/overlay/shared/settings?error=invalid_id');
    expect(loc(await post('/import/10'))).toBe('/overlay/shared/settings?error=not_found');
    expect(files.recordSharedVideo).not.toHaveBeenCalled();
  });

  it('turns an import away with transcode_busy before copying anything when the conversion queue is full', async () => {
    transcode.isWebmTranscodeQueueFull.mockReturnValue(true);
    expect(loc(await post('/import/9'))).toBe('/overlay/shared/settings?error=transcode_busy');
    expect(files.storeSharedVideo).not.toHaveBeenCalled();
    expect(files.recordSharedVideo).not.toHaveBeenCalled();
  });

  it('turns a fourth concurrent import away with upload_busy and frees the slots afterwards', async () => {
    const release: Array<() => void> = [];
    files.storeSharedVideo.mockImplementation(() => new Promise<string>((resolve) => { release.push(() => resolve('new.webm')); }));
    const running = [1, 2, 3].map(() => post('/import/9').then((r) => loc(r)));
    await waitFor(() => expect(files.storeSharedVideo).toHaveBeenCalledTimes(3));
    expect(loc(await post('/import/9'))).toBe('/overlay/shared/settings?error=upload_busy');
    expect(files.storeSharedVideo).toHaveBeenCalledTimes(3);
    release.forEach((r) => r());
    expect(await Promise.all(running)).toEqual(Array(3).fill('/overlay/shared/settings?success=video_added'));
    files.storeSharedVideo.mockResolvedValue('after.webm');
    expect(loc(await post('/import/9'))).toBe('/overlay/shared/settings?success=video_added');
  });

  it('frees the import slot when the conversion fails', async () => {
    files.storeSharedVideo.mockRejectedValue(Object.assign(new Error('x'), { code: 'transcode_failed' }));
    for (let i = 0; i < 4; i++) {
      expect(loc(await post('/import/9'))).toBe('/overlay/shared/settings?error=transcode_failed');
    }
  });

  it('reports a failed conversion and records nothing', async () => {
    files.storeSharedVideo.mockRejectedValue(Object.assign(new Error('x'), { code: 'transcode_failed' }));
    expect(loc(await post('/import/9'))).toBe('/overlay/shared/settings?error=transcode_failed');
    expect(files.recordSharedVideo).not.toHaveBeenCalled();
  });
});
