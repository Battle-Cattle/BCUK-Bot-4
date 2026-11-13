import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

/** Mocks the shared logger so route handlers don't write real log output during tests. */
vi.mock('../chunkedUploadStore', async (importOriginal) =>
  (await import('../../test-utils/chunkedUploadTest.js')).mockChunkedUploadStoreModule(await importOriginal<object>()));
vi.mock('./chunkedUploadRoutes', async (importOriginal) =>
  (await import('../../test-utils/chunkedUploadTest.js')).mockChunkedUploadRoutesModule(await importOriginal<object>()));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  addVideo: vi.fn(),
  deleteVideo: vi.fn(),
  deleteReward: vi.fn(),
  getVideosForStreamer: vi.fn(),
  getLibraryVideos: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));

vi.mock('../csrf', () => ({
  csrfProtection: vi.fn((req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  }),
}));

vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../shared/config', () => ({
  OVERLAY_FOLDER: '/app/overlay-videos',
  // Use 1 MB so the oversized-upload test can exceed the limit with a small buffer.
  OVERLAY_MAX_FILE_MB: 1,
  // 1000 bytes per streamer, so the tests' byte-sized "videos" can reach the cap.
  OVERLAY_MAX_TOTAL_MB_PER_STREAMER: 1000 / (1024 * 1024),
  OVERLAY_LIBRARY_MAX_TOTAL_MB: 10,
}));

vi.mock('fs', () => ({
  default: {
    promises: {
      mkdir: vi.fn(),
      rm: vi.fn(),
    },
  },
}));

// Keeps uploads in memory and detects their type from the buffer, so these tests drive the route
// without a disk; overlayUploadStorage.test.ts covers the real disk storage.
vi.mock('./overlayUploadStorage', async () => {
  const { detectVideoType } = await import('./uploadFileTypes.js');
  const { fakeToMemoryFile } = await import('../../test-utils/chunkedUploadTest.js');
  return {
    detectUploadedVideoType: vi.fn(async (file: UploadedFile) => detectVideoType(file.buffer)),
    placeUpload: vi.fn(),
    discardUpload: vi.fn(),
    sweepStaleIncomingUploads: vi.fn(),
    INCOMING_DIR: '/app/overlay-videos/.incoming',
    adoptChunkedUpload: fakeToMemoryFile,
  };
});

// The storage cap sums the sizes of the streamer's rows (the real overlayStorageQuota), with each
// file's size faked here since there's no disk; overlayStorageQuota.test.ts measures real files.
vi.mock('./overlayVideoLibraryFiles', () => ({
  LIBRARY_FOLDER: 'library',
  streamerFolder: (id: number) => String(id),
  videoFileSize: vi.fn(),
}));

vi.mock('./overlayMovConversion', () => ({ storeMovAsWebm: vi.fn() }));
vi.mock('./overlayVideoTranscode', () => ({ isWebmTranscodeQueueFull: vi.fn() }));

import { uploadRequest } from '../../test-utils/chunkedUploadTest';
import type { UploadedFile } from '../uploadedFile';
import supertest from 'supertest';
import { router, overlayUploadSlots, MAX_CONCURRENT_OVERLAY_UPLOADS } from './overlayAdminMutations';
import { waitFor } from '../../test-utils/waitFor';
import { getStreamerByDiscordId, addVideo, deleteVideo, getVideosForStreamer } from '../../db';
import { videoFileSize } from './overlayVideoLibraryFiles';
import { AccessLevel } from '../../db';
import fs from 'fs';
import { csrfProtection } from '../csrf';
import { storeMovAsWebm } from './overlayMovConversion';
import { isWebmTranscodeQueueFull } from './overlayVideoTranscode';
import { getConversionProgress, claimConversionProgress, releaseConversionProgress } from './overlayConversionProgress';
import { placeUpload, discardUpload, sweepStaleIncomingUploads } from './overlayUploadStorage';
import type { RequestHandler } from 'express';
import { buildTestApp } from '../../test-utils/expressTestApp';

// Minimal buffers with correct magic bytes for each format
const WEBM_BUF = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
const MP4_BUF  = Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]);
const MOV_BUF  = Buffer.from([0x00, 0x00, 0x00, 0x14, ...Buffer.from('ftypqt  ', 'ascii')]);

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3 };
const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: AccessLevel.USER };

const MOCK_STREAMER = {
  id: 123,
  twitch_user_id: 'twitch123',
  twitch_name: 'teststreamer',
  discord_id: USER.discordId,
};

/** Builds a supertest-ready app: the overlay admin mutations router with a stubbed session (no render stub — these routes redirect). */
function buildApp(sessionUser: SessionUser = USER, before: RequestHandler[] = []) {
  return buildTestApp({ router: [...before, router], bodyParser: 'urlencoded', sessionUser });
}

/**
 * Sets what the streamer has stored: one DB row per entry, sized as given. Any other file (a
 * newly stored upload) measures `newFileBytes`.
 */
function storedVideos(sizes: Record<string, number>, newFileBytes = 8) {
  vi.mocked(getVideosForStreamer).mockResolvedValue(Object.keys(sizes).map((filename) => ({ filename })) as any);
  vi.mocked(videoFileSize).mockImplementation(async ({ filename }) => sizes[filename] ?? newFileBytes);
}

/**
 * Takes `count` upload slots with handlers that stay pending, as if that many uploads were being
 * processed. `release` lets them finish.
 */
function holdUploadSlots(count: number) {
  const finishers: Array<() => void> = [];
  const runs = Array.from({ length: count }, () => overlayUploadSlots.admit(
    () => new Promise<void>((resolve) => { finishers.push(resolve); }),
  )({} as any, { redirect: vi.fn() } as any));
  return {
    release: async () => {
      finishers.forEach((finish) => finish());
      await Promise.all(runs);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  vi.mocked(addVideo).mockResolvedValue(1);
  vi.mocked(deleteVideo).mockResolvedValue(null);
  storedVideos({});
  vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);
  vi.mocked(placeUpload).mockResolvedValue(undefined);
  vi.mocked(discardUpload).mockResolvedValue(undefined);
  vi.mocked(sweepStaleIncomingUploads).mockResolvedValue(undefined);
  vi.mocked(fs.promises.rm).mockResolvedValue(undefined);
  vi.mocked(isWebmTranscodeQueueFull).mockReturnValue(false);
  vi.mocked(storeMovAsWebm).mockImplementation(async (_dir, baseName) => `${baseName}.webm`);
});

// --- POST /settings/videos/upload ---

describe('POST /settings/videos/upload', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', Buffer.from('fake video'), 'test.mp4');
    expect(res.headers.location).toBe('/overlay/settings?error=not_a_streamer');
  });

  it('redirects a completion with no upload behind it to upload_expired, storing nothing', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await uploadRequest(buildApp()).post('/settings/videos/upload');
    expect(res.headers.location).toBe('/overlay/settings?error=upload_expired');
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
    expect(vi.mocked(discardUpload)).not.toHaveBeenCalled();
  });

  it('rolls back the written file when addVideo fails', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(addVideo).mockRejectedValue(new Error('DB error'));
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', MP4_BUF, { filename: 'test.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?error=upload_failed');
    expect(vi.mocked(placeUpload)).toHaveBeenCalled();
    const storedPath = vi.mocked(placeUpload).mock.calls[0]![1];
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalledWith(storedPath, { force: true });
  });

  it('skips the DB insert and discards the upload when moving it into place fails', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(placeUpload).mockRejectedValueOnce(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', MP4_BUF, { filename: 'test.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?error=upload_failed');
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
    expect(vi.mocked(discardUpload)).toHaveBeenCalledOnce();
  });

  it.each([
    ['a stored WebM', WEBM_BUF, 'clip.webm', 'video/webm'],
    ['a rejected non-video', Buffer.from('not a video at all'), 'clip.webm', 'video/webm'],
  ])('discards the incoming file and sweeps stale ones after %s', async (_label, buf, filename, contentType) => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    await uploadRequest(buildApp()).post('/settings/videos/upload').attach('video', buf, { filename, contentType });
    expect(vi.mocked(discardUpload)).toHaveBeenCalledWith(expect.objectContaining({ originalname: filename }));
    expect(vi.mocked(sweepStaleIncomingUploads)).toHaveBeenCalledOnce();
  });

  it('successfully uploads a valid mp4 file', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', MP4_BUF, { filename: 'test.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
    expect(vi.mocked(fs.promises.mkdir)).toHaveBeenCalled();
    const [file, storedPath] = vi.mocked(placeUpload).mock.calls[0]!;
    expect(file.originalname).toBe('test.mp4');
    expect(storedPath).toMatch(/[\\/]123[\\/][0-9a-f-]{36}\.mp4$/);
    expect(vi.mocked(addVideo)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'Test Video', storedPath.split(/[\\/]/).at(-1));
  });

  it('names the video after the uploaded file when no name field is sent', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', MP4_BUF, { filename: '  clip.mp4 ', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
    expect(vi.mocked(addVideo)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'clip.mp4', expect.any(String));
  });

  it('names the video after the uploaded file when the name field is blank', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .field('name', '   ')
      .attach('video', MP4_BUF, { filename: 'clip.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
    expect(vi.mocked(addVideo)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'clip.mp4', expect.any(String));
  });

  it('rejects the upload if the streamer is unlinked between the pre-upload check and the handler', async () => {
    // The guard passes on start and on complete; the handler's own check then finds no streamer.
    vi.mocked(getStreamerByDiscordId)
      .mockResolvedValueOnce(MOCK_STREAMER as any).mockResolvedValueOnce(MOCK_STREAMER as any).mockResolvedValueOnce(null);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', MP4_BUF, { filename: 'test.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?error=not_a_streamer');
    expect(vi.mocked(placeUpload)).not.toHaveBeenCalled();
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });

  it('redirects with upload_failed when something non-Error is thrown', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(addVideo).mockRejectedValue('not an Error');
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', MP4_BUF, { filename: 'test.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?error=upload_failed');
    // The DB insert failed after the file was stored, so the file is rolled back.
    expect(vi.mocked(placeUpload)).toHaveBeenCalledOnce();
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalledWith(vi.mocked(placeUpload).mock.calls[0]![1], { force: true });
  });

  it('successfully uploads a valid webm file', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test WebM')
      .attach('video', WEBM_BUF, { filename: 'test.webm', contentType: 'video/webm' });
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
    expect(vi.mocked(addVideo)).toHaveBeenCalled();
  });

  it('stores a MOV through the WebM conversion and records the converted file', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Transparent Clip')
      .attach('video', MOV_BUF, { filename: 'clip.mov', contentType: 'video/quicktime' });
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
    const [dir, baseName, placeSource] = vi.mocked(storeMovAsWebm).mock.calls[0]!;
    // path.resolve uses the platform's separator, so accept either.
    expect(dir).toMatch(/[\\/]app[\\/]overlay-videos[\\/]123$/);
    expect(baseName).toMatch(/^[0-9a-f-]{36}$/);
    expect(vi.mocked(addVideo)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'Transparent Clip', `${baseName}.webm`);
    // The conversion puts the upload at its temporary source path by moving the finished upload there.
    expect(vi.mocked(placeUpload)).not.toHaveBeenCalled();
    await placeSource('/tmp/source.mov.upload');
    expect(vi.mocked(placeUpload)).toHaveBeenCalledWith(expect.objectContaining({ originalname: 'clip.mov' }), '/tmp/source.mov.upload');
  });

  it.each(['transcode_failed', 'transcode_busy'])('redirects with %s when the MOV cannot be stored', async (code) => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(storeMovAsWebm).mockRejectedValue(Object.assign(new Error('conversion'), { code }));
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', MOV_BUF, { filename: 'clip.mov', contentType: 'video/quicktime' });
    expect(res.headers.location).toBe(`/overlay/settings?error=${code}`);
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });

  it('publishes a MOV conversion\'s progress under the page\'s upload ID while it runs, then clears it', async () => {
    const uploadId = 'a'.repeat(32);
    let seenDuringConversion: unknown;
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(storeMovAsWebm).mockImplementation(async (_dir, baseName, _buffer, onProgress) => {
      onProgress?.({ stage: 'converting', percent: 42 });
      seenDuringConversion = getConversionProgress(MOCK_STREAMER.id, uploadId);
      return `${baseName}.webm`;
    });
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .set('X-Upload-Id', uploadId)
      .attach('video', MOV_BUF, { filename: 'clip.mov', contentType: 'video/quicktime' });
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
    expect(seenDuringConversion).toEqual({ stage: 'converting', percent: 42 });
    expect(getConversionProgress(MOCK_STREAMER.id, uploadId)).toBeUndefined();
  });

  it('clears the published progress when the conversion fails', async () => {
    const uploadId = 'b'.repeat(32);
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(storeMovAsWebm).mockImplementation(async (_dir, _baseName, _buffer, onProgress) => {
      onProgress?.({ stage: 'converting', percent: 10 });
      throw Object.assign(new Error('ffmpeg'), { code: 'transcode_failed' });
    });
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .set('X-Upload-Id', uploadId)
      .attach('video', MOV_BUF, { filename: 'clip.mov', contentType: 'video/quicktime' });
    expect(res.headers.location).toBe('/overlay/settings?error=transcode_failed');
    expect(getConversionProgress(MOCK_STREAMER.id, uploadId)).toBeUndefined();
  });

  it('converts without tracking progress when another request already holds the upload ID', async () => {
    const uploadId = 'd'.repeat(32);
    const otherRequest = claimConversionProgress(MOCK_STREAMER.id, uploadId)!;
    try {
      vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
      const res = await uploadRequest(buildApp())
        .post('/settings/videos/upload')
        .set('X-Upload-Id', uploadId)
        .attach('video', MOV_BUF, { filename: 'clip.mov', contentType: 'video/quicktime' });
      expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
      expect(vi.mocked(storeMovAsWebm).mock.calls[0]![3]).toBeUndefined();
    } finally {
      releaseConversionProgress(MOCK_STREAMER.id, uploadId, otherRequest);
    }
  });

  it('converts without publishing progress when the upload ID is missing or malformed', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .set('X-Upload-Id', '../not-an-id')
      .attach('video', MOV_BUF, { filename: 'clip.mov', contentType: 'video/quicktime' });
    expect(vi.mocked(storeMovAsWebm).mock.calls[0]![3]).toBeUndefined();
  });

  it('removes the converted WebM when the DB insert fails after a MOV conversion', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(addVideo).mockRejectedValue(new Error('DB error'));
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', MOV_BUF, { filename: 'clip.mov', contentType: 'video/quicktime' });
    expect(res.headers.location).toBe('/overlay/settings?error=upload_failed');
    const baseName = vi.mocked(storeMovAsWebm).mock.calls[0]![1];
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`${baseName}\\.webm$`)), { force: true });
  });

  it('refuses to start any upload with upload_busy while the most uploads are already being processed', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const held = holdUploadSlots(MAX_CONCURRENT_OVERLAY_UPLOADS);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', WEBM_BUF, { filename: 'clip.webm', contentType: 'video/webm' });
    await held.release();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'upload_busy' });
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });

  it('holds its upload slot for the whole conversion and frees it once the upload is processed', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    let finishConversion!: () => void;
    vi.mocked(storeMovAsWebm).mockImplementation((_dir, baseName) =>
      new Promise((resolve) => { finishConversion = () => resolve(`${baseName}.webm`); }));
    const held = holdUploadSlots(MAX_CONCURRENT_OVERLAY_UPLOADS - 1);
    const upload = uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', MOV_BUF, { filename: 'clip.mov', contentType: 'video/quicktime' })
      .then((r) => r);
    await waitFor(() => expect(vi.mocked(storeMovAsWebm)).toHaveBeenCalled());
    expect(overlayUploadSlots.isFull()).toBe(true);
    finishConversion();
    expect((await upload).headers.location).toBe('/overlay/settings?success=video_uploaded');
    expect(overlayUploadSlots.isFull()).toBe(false);
    await held.release();
  });

  it.each([
    ['an invalid file', MP4_BUF.subarray(0, 2), undefined],
    ['a DB failure', MP4_BUF, () => vi.mocked(addVideo).mockRejectedValue(new Error('DB error'))],
  ])('frees its upload slot after %s', async (_label, buffer, arrange) => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    arrange?.();
    // More uploads in a row than there are slots: each one only gets in if the last freed its slot.
    for (let i = 0; i <= MAX_CONCURRENT_OVERLAY_UPLOADS; i++) {
      const res = await uploadRequest(buildApp())
        .post('/settings/videos/upload')
        .attach('video', buffer, { filename: 'clip.mp4', contentType: 'video/mp4' });
      expect(res.headers.location).toMatch(/\?error=(invalid_file|upload_failed)$/);
    }
    expect(overlayUploadSlots.isFull()).toBe(false);
  });

  it.each([
    ['a .mov name', { filename: 'clip.mov', contentType: 'application/octet-stream' }],
    ['a video/quicktime type', { filename: 'clip', contentType: 'video/quicktime' }],
  ])('refuses to start an upload declared as MOV by %s when the conversion queue is full', async (_label, attach) => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(isWebmTranscodeQueueFull).mockReturnValue(true);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', MOV_BUF, attach);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'transcode_busy' });
    expect(vi.mocked(storeMovAsWebm)).not.toHaveBeenCalled();
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });

  it.each([['at', 1000], ['over', 1200]])('refuses to start an upload with storage_limit when the streamer is %s their cap', async (_label, used) => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    storedVideos({ 'old.webm': used });
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', WEBM_BUF, { filename: 'clip.webm', contentType: 'video/webm' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'storage_limit' });
    expect(vi.mocked(getVideosForStreamer)).toHaveBeenCalledWith(MOCK_STREAMER.id);
    expect(vi.mocked(placeUpload)).not.toHaveBeenCalled();
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });

  it('refuses a finished upload with storage_limit, removing the stored file, when it would take the streamer over their cap', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    // Under the cap at start (so the upload begins), but the 8-byte file makes 1001 of 1000.
    storedVideos({ 'old.webm': 993 });
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', WEBM_BUF, { filename: 'clip.webm', contentType: 'video/webm' });
    expect(res.headers.location).toBe('/overlay/settings?error=storage_limit');
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
    const [, storedPath] = vi.mocked(placeUpload).mock.calls[0]!;
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalledWith(storedPath, { force: true });
  });

  it('accepts an upload that fills the cap exactly, measuring the stored file in the streamer\'s folder', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    storedVideos({ 'old.webm': 992 });
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', WEBM_BUF, { filename: 'clip.webm', contentType: 'video/webm' });
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
    const [, , filename] = vi.mocked(addVideo).mock.calls[0]!;
    expect(vi.mocked(videoFileSize)).toHaveBeenCalledWith({ folder: String(MOCK_STREAMER.id), filename });
    expect(vi.mocked(fs.promises.rm)).not.toHaveBeenCalled();
  });

  it('accepts a MOV whose declared size is over the remaining quota when its converted WebM fits', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    // 100 bytes left. The MOV is 400 bytes as uploaded, but its converted WebM is 15.
    storedVideos({ 'old.webm': 900 }, 15);
    const mov = Buffer.concat([MOV_BUF, Buffer.alloc(400 - MOV_BUF.length)]);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', mov, { filename: 'clip.mov', contentType: 'video/quicktime' });
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
    expect(vi.mocked(addVideo)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'clip.mov', expect.stringMatching(/\.webm$/));
  });

  it('refuses a MOV whose converted WebM still takes the streamer over their cap, removing it', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    storedVideos({ 'old.webm': 900 }, 101);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', MOV_BUF, { filename: 'clip.mov', contentType: 'video/quicktime' });
    expect(res.headers.location).toBe('/overlay/settings?error=storage_limit');
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
    const [, baseName] = vi.mocked(storeMovAsWebm).mock.calls[0]!;
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`${baseName}\\.webm$`)), { force: true });
  });

  it('accepts an upload again once the streamer has deleted a video', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    storedVideos({ 'old.webm': 600, 'older.webm': 400 });
    const attach = () => uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', WEBM_BUF, { filename: 'clip.webm', contentType: 'video/webm' });
    expect((await attach()).body).toEqual({ error: 'storage_limit' });
    // Deleting a video removes its row, which is what the total is summed from.
    storedVideos({ 'old.webm': 600 });
    expect((await attach()).headers.location).toBe('/overlay/settings?success=video_uploaded');
  });

  it('removes the stored file and reports upload_failed when it can\'t be measured', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(videoFileSize).mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', WEBM_BUF, { filename: 'clip.webm', contentType: 'video/webm' });
    expect(res.headers.location).toBe('/overlay/settings?error=upload_failed');
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalled();
  });

  it('records nothing and reports upload_failed when the stored file is no longer there to measure', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(videoFileSize).mockResolvedValue(null);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', WEBM_BUF, { filename: 'clip.webm', contentType: 'video/webm' });
    expect(res.headers.location).toBe('/overlay/settings?error=upload_failed');
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
    const [, storedPath] = vi.mocked(placeUpload).mock.calls[0]!;
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalledWith(storedPath, { force: true });
  });

  it('still accepts WebM and MP4 uploads while the conversion queue is full', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(isWebmTranscodeQueueFull).mockReturnValue(true);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', WEBM_BUF, { filename: 'clip.webm', contentType: 'video/webm' });
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
  });

  it('does not convert WebM or MP4 uploads', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', MP4_BUF, { filename: 'test.mp4', contentType: 'video/mp4' });
    expect(vi.mocked(storeMovAsWebm)).not.toHaveBeenCalled();
  });

  it('rejects a file with no recognised magic bytes even if MIME type is correct', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Bad File')
      .attach('video', Buffer.from('not a real video'), { filename: 'evil.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_file');
    expect(vi.mocked(placeUpload)).not.toHaveBeenCalled();
  });

  it('rejects a non-streamer before the upload starts (oversized file gets not_a_streamer, not file_too_large)', async () => {
    const oversized = Buffer.alloc(1024 * 1024 + 1024, 1);
    const res = await uploadRequest(buildApp(USER))
      .post('/settings/videos/upload')
      .attach('video', oversized, { filename: 'big.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?error=not_a_streamer');
    expect(vi.mocked(getStreamerByDiscordId)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(placeUpload)).not.toHaveBeenCalled();
  });

  it('redirects with upload_failed when the pre-upload streamer lookup fails', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValueOnce(new Error('DB down'));
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', WEBM_BUF, 'test.webm');
    expect(res.headers.location).toBe('/overlay/settings?error=upload_failed');
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });

  it('refuses to start an upload over the size limit with file_too_large', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const oversized = Buffer.alloc(1024 * 1024 + 1024, 1); // > 1 MB limit set above
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', oversized, { filename: 'big.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'file_too_large' });
    expect(vi.mocked(placeUpload)).not.toHaveBeenCalled();
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });
});

// --- POST /settings/videos/upload - CSRF Protection ---

describe('POST /settings/videos/upload — CSRF protection', () => {
  it('rejects with 403 and stores nothing when the CSRF token is invalid', async () => {
    vi.mocked(csrfProtection).mockImplementationOnce((_req, res, _next) => {
      res.status(403).send('invalid csrf token');
    });

    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', Buffer.from('fake video'), { filename: 'test.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(403);
    // No upload may have been processed: no file written, no DB call
    expect(vi.mocked(placeUpload)).not.toHaveBeenCalled();
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });
});

// --- POST /settings/videos/upload - Path Traversal Protection ---

describe('POST /settings/videos/upload — path traversal protection', () => {
  it('blocks path traversal with ../ in streamer id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ ...MOCK_STREAMER, id: '../../../etc/passwd' } as any);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', MP4_BUF, { filename: 'test.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_path');
    expect(vi.mocked(placeUpload)).not.toHaveBeenCalled();
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });

  it('blocks absolute path in streamer id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ ...MOCK_STREAMER, id: '/etc/passwd' } as any);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', MP4_BUF, { filename: 'test.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_path');
    expect(vi.mocked(placeUpload)).not.toHaveBeenCalled();
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });

  it('allows valid numeric streamer id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ ...MOCK_STREAMER, id: 456 } as any);
    const res = await uploadRequest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', MP4_BUF, { filename: 'test.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
    expect(vi.mocked(placeUpload)).toHaveBeenCalled();
    expect(vi.mocked(addVideo)).toHaveBeenCalled();
  });
});

// --- POST /settings/videos/:id/delete ---

describe('POST /settings/videos/:id/delete', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp()).post('/settings/videos/1/delete');
    expect(res.headers.location).toBe('/overlay/settings?error=not_a_streamer');
  });

  it('redirects with error for invalid video id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/settings/videos/invalid/delete');
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_id');
  });

  it('successfully deletes a video', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(deleteVideo).mockResolvedValue('test-video.mp4');
    const res = await supertest(buildApp()).post('/settings/videos/1/delete');
    expect(res.headers.location).toBe('/overlay/settings?success=video_deleted');
    expect(vi.mocked(deleteVideo)).toHaveBeenCalledWith(1, MOCK_STREAMER.id);
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalled();
  });

  it('skips rm when deleteVideo returns null', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(deleteVideo).mockResolvedValue(null);
    const res = await supertest(buildApp()).post('/settings/videos/1/delete');
    expect(res.headers.location).toBe('/overlay/settings?success=video_deleted');
    expect(vi.mocked(fs.promises.rm)).not.toHaveBeenCalled();
  });

  it('skips rm when the deleted row names a file outside the streamer folder', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(deleteVideo).mockResolvedValue('../../escape.mp4');
    const res = await supertest(buildApp()).post('/settings/videos/1/delete');
    expect(res.headers.location).toBe('/overlay/settings?success=video_deleted');
    expect(vi.mocked(fs.promises.rm)).not.toHaveBeenCalled();
  });

  it('still reports success when removing the file fails (post-commit cleanup, not rolled back)', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(deleteVideo).mockResolvedValue('test-video.mp4');
    vi.mocked(fs.promises.rm).mockRejectedValueOnce(new Error('EACCES'));
    const res = await supertest(buildApp()).post('/settings/videos/1/delete');
    expect(res.headers.location).toBe('/overlay/settings?success=video_deleted');
  });
});


