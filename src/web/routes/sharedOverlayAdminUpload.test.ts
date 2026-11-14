import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { waitFor } from '../../test-utils/waitFor';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({ OVERLAY_MAX_FILE_MB: 100, OVERLAY_FOLDER: '/o' }));
vi.mock('../csrf', () => ({ csrfProtection: vi.fn() }));
vi.mock('../session', () => ({ getSessionUser: () => ({ discordId: 'u1' }) }));
const mounted = vi.hoisted(() => ({ options: undefined as any }));
vi.mock('./chunkedUploadRoutes', () => ({
  mountChunkedUploadRoutes: (_r: unknown, options: unknown) => { mounted.options = options; },
}));
vi.mock('../chunkedUploadStore', () => ({ ChunkedUploadStore: class {} }));
const storage = vi.hoisted(() => ({
  adoptChunkedUpload: vi.fn(), detectUploadedVideoType: vi.fn(), placeUpload: vi.fn(),
  discardUpload: vi.fn(async () => {}), sweepStaleIncomingUploads: vi.fn(async () => {}), INCOMING_DIR: '/o/.incoming',
}));
vi.mock('./overlayUploadStorage', () => storage);
const files = vi.hoisted(() => ({ storeSharedVideo: vi.fn(), recordSharedVideo: vi.fn() }));
vi.mock('./sharedOverlayVideoStorage', () => files);
const broadcast = vi.fn();
vi.mock('./sharedOverlaySource', () => ({ broadcastSharedVideoList: (...a: unknown[]) => broadcast(...a) }));
const transcode = vi.hoisted(() => ({ isWebmTranscodeQueueFull: vi.fn(() => false) }));
vi.mock('./overlayVideoTranscode', () => transcode);
const progress = vi.hoisted(() => ({
  parseUploadId: vi.fn((v: unknown) => (v === 'a'.repeat(32) ? v : null)),
  claimConversionProgress: vi.fn(() => Symbol('o')),
  setConversionProgress: vi.fn(), releaseConversionProgress: vi.fn(),
}));
vi.mock('./overlayConversionProgress', () => progress);

import './sharedOverlayAdminUpload';

/** Runs the mounted `complete` handler for a fake request and returns its response stub. */
async function complete(req: any) {
  const res: any = { redirect: vi.fn(), status: vi.fn().mockReturnThis(), end: vi.fn() };
  req.get = (h: string) => (h === 'x-upload-id' ? req.uploadId : undefined);
  const [handle] = mounted.options.complete;
  await handle(req, res);
  return { res };
}

const file = { originalname: 'clip.mp4' };

beforeEach(() => {
  vi.clearAllMocks();
  storage.detectUploadedVideoType.mockResolvedValue('mp4');
  files.storeSharedVideo.mockImplementation(async (place: (p: string) => Promise<void>, onProgress?: (p: unknown) => void) => {
    await place('/o/shared/x.mov.upload');
    onProgress?.({ stage: 'converting', percent: 50 });
    return 'x.webm';
  });
  broadcast.mockResolvedValue(1);
  files.recordSharedVideo.mockResolvedValue(1);
});

describe('chunked upload mounting', () => {
  it('mounts under /upload with CSRF and the Manager-gated parent router', () => {
    expect(mounted.options).toMatchObject({ path: '/upload', field: 'video', basePath: '/overlay/shared/settings' });
  });

  it('turns an upload away at start while the conversion queue is full', () => {
    expect(mounted.options.checkStart()).toBeNull();
    transcode.isWebmTranscodeQueueFull.mockReturnValueOnce(true);
    expect(mounted.options.checkStart()).toBe('transcode_busy');
  });
});

describe('completing an upload', () => {
  it.each(['mp4', 'webm', 'mov'])('converts a %s to WebM, records it and broadcasts', async (type) => {
    storage.detectUploadedVideoType.mockResolvedValue(type);
    const { res } = await complete({ file, body: { name: ' Clap ' }, uploadId: 'a'.repeat(32) });
    expect(storage.placeUpload).toHaveBeenCalledWith(file, '/o/shared/x.mov.upload');
    expect(files.recordSharedVideo).toHaveBeenCalledWith('Clap', 'x.webm', 'u1');
    expect(progress.setConversionProgress).toHaveBeenCalled();
    expect(progress.releaseConversionProgress).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/overlay/shared/settings?success=video_uploaded');
    expect(storage.discardUpload).toHaveBeenCalledWith(file);
  });

  it('falls back to the file name when no name is given', async () => {
    await complete({ file, body: {}, uploadId: null });
    expect(files.recordSharedVideo).toHaveBeenCalledWith('clip.mp4', 'x.webm', 'u1');
  });

  it('rejects a file that is not a video, recording nothing', async () => {
    storage.detectUploadedVideoType.mockResolvedValue(null);
    const { res } = await complete({ file, body: {}, uploadId: null });
    expect(res.redirect).toHaveBeenCalledWith('/overlay/shared/settings?error=invalid_file');
    expect(files.storeSharedVideo).not.toHaveBeenCalled();
    expect(files.recordSharedVideo).not.toHaveBeenCalled();
  });

  it('reports a failed conversion and records nothing', async () => {
    files.storeSharedVideo.mockRejectedValue(Object.assign(new Error('x'), { code: 'transcode_failed' }));
    const { res } = await complete({ file, body: {}, uploadId: 'a'.repeat(32) });
    expect(res.redirect).toHaveBeenCalledWith('/overlay/shared/settings?error=transcode_failed');
    expect(files.recordSharedVideo).not.toHaveBeenCalled();
    expect(progress.releaseConversionProgress).toHaveBeenCalled();
    expect(storage.discardUpload).toHaveBeenCalled();
  });

  it('answers upload_failed on an unexpected error', async () => {
    files.recordSharedVideo.mockRejectedValue(new Error('db'));
    const { res } = await complete({ file, body: {}, uploadId: null });
    expect(res.redirect).toHaveBeenCalledWith('/overlay/shared/settings?error=upload_failed');
  });

  it('redirects invalid_file when there is no file', async () => {
    const { res } = await complete({ file: undefined, body: {}, uploadId: null });
    expect(res.redirect).toHaveBeenCalledWith('/overlay/shared/settings?error=invalid_file');
  });

  it('still succeeds when the list broadcast fails', async () => {
    broadcast.mockRejectedValue(new Error('x'));
    const { res } = await complete({ file, body: {}, uploadId: null });
    expect(res.redirect).toHaveBeenCalledWith('/overlay/shared/settings?success=video_uploaded');
  });

  it('turns away a fourth concurrent upload with upload_busy until one of them has been processed', async () => {
    const pending: Array<() => void> = [];
    files.storeSharedVideo.mockImplementation(() => new Promise<string>((resolve) => { pending.push(() => resolve('x.webm')); }));
    const running = [1, 2, 3].map(() => complete({ file, body: {}, uploadId: null }));
    await waitFor(() => expect(pending).toHaveLength(3));
    expect(mounted.options.checkStart()).toBe('upload_busy');
    const fourth = await complete({ file: { originalname: 'd.mp4' }, body: {}, uploadId: null });
    expect(fourth.res.redirect).toHaveBeenCalledWith('/overlay/shared/settings?error=upload_busy');
    expect(storage.discardUpload).toHaveBeenCalledWith({ originalname: 'd.mp4' });
    pending.forEach((done) => done());
    await Promise.all(running);
    expect(mounted.options.checkStart()).toBeNull();
  });
});
