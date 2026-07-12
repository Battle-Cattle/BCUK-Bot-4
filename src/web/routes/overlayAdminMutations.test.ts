import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  addVideo: vi.fn(),
  deleteVideo: vi.fn(),
  upsertReward: vi.fn(),
  setRewardVideos: vi.fn(),
  deleteReward: vi.fn(),
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
  // Use 1 MB so the oversized-upload test can trigger Multer's LIMIT_FILE_SIZE with a small buffer.
  OVERLAY_MAX_FILE_MB: 1,
}));

vi.mock('fs', () => ({
  default: {
    promises: {
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      rm: vi.fn(),
    },
  },
}));

import supertest from 'supertest';
import multer from 'multer';
import { router, detectVideoType, handleUploadError } from './overlayAdminMutations';
import { getStreamerByDiscordId, addVideo, deleteVideo } from '../../db';
import { AccessLevel } from '../../db/users';
import fs from 'fs';
import { csrfProtection } from '../csrf';
import { buildTestApp } from '../../test-utils/expressTestApp';

// Minimal buffers with correct magic bytes for each format
const WEBM_BUF = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
const MP4_BUF  = Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]);

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3 };
const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: AccessLevel.USER };

const MOCK_STREAMER = {
  id: 123,
  twitch_user_id: 'twitch123',
  twitch_name: 'teststreamer',
  discord_id: USER.discordId,
};

/** Builds a supertest-ready app: the overlay admin mutations router with a stubbed session (no render stub — these routes redirect). */
function buildApp(sessionUser: SessionUser = USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  vi.mocked(addVideo).mockResolvedValue(1);
  vi.mocked(deleteVideo).mockResolvedValue(null);
  vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);
  vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);
  vi.mocked(fs.promises.rm).mockResolvedValue(undefined);
});

// --- POST /settings/videos/upload ---

describe('POST /settings/videos/upload', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', Buffer.from('fake video'), 'test.mp4');
    expect(res.headers.location).toBe('/overlay/settings?error=not_a_streamer');
  });

  it('redirects with error when no file is uploaded', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/settings/videos/upload');
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_file');
  });

  it('rolls back the written file when addVideo fails', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(addVideo).mockRejectedValue(new Error('DB error'));
    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', MP4_BUF, { filename: 'test.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?error=upload_failed');
    expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalled();
    const writtenPath = vi.mocked(fs.promises.writeFile).mock.calls[0][0] as string;
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalledWith(writtenPath, { force: true });
  });

  it('successfully uploads a valid mp4 file', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', MP4_BUF, { filename: 'test.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
    expect(vi.mocked(fs.promises.mkdir)).toHaveBeenCalled();
    expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalled();
    expect(vi.mocked(addVideo)).toHaveBeenCalled();
  });

  it('successfully uploads a valid webm file', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test WebM')
      .attach('video', WEBM_BUF, { filename: 'test.webm', contentType: 'video/webm' });
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
    expect(vi.mocked(addVideo)).toHaveBeenCalled();
  });

  it('rejects a file with no recognised magic bytes even if MIME type is correct', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Bad File')
      .attach('video', Buffer.from('not a real video'), { filename: 'evil.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_file');
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
  });

  // End-to-end: locks the uploadVideo → handleUploadError wiring so the route still
  // redirects (rather than 500s) if the middleware chain or ordering ever changes.
  it('redirects an oversized upload to file_too_large via the route middleware', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const oversized = Buffer.alloc(1024 * 1024 + 1024, 1); // > 1 MB limit set above
    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .attach('video', oversized, { filename: 'big.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?error=file_too_large');
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });
});

// --- POST /settings/videos/upload - CSRF Protection ---

describe('POST /settings/videos/upload — CSRF protection', () => {
  it('rejects with 403 and does not invoke Multer when CSRF token is invalid', async () => {
    vi.mocked(csrfProtection).mockImplementationOnce((_req, res, _next) => {
      res.status(403).send('invalid csrf token');
    });

    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', Buffer.from('fake video'), { filename: 'test.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(403);
    // Multer file processing must not have proceeded: no file written, no DB call
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });
});

// --- POST /settings/videos/upload - Path Traversal Protection ---

describe('POST /settings/videos/upload — path traversal protection', () => {
  it('blocks path traversal with ../ in streamer id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ ...MOCK_STREAMER, id: '../../../etc/passwd' } as any);
    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', MP4_BUF, { filename: 'test.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_path');
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });

  it('blocks absolute path in streamer id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ ...MOCK_STREAMER, id: '/etc/passwd' } as any);
    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', MP4_BUF, { filename: 'test.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_path');
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });

  it('allows valid numeric streamer id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ ...MOCK_STREAMER, id: 456 } as any);
    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', MP4_BUF, { filename: 'test.mp4', contentType: 'video/mp4' });
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
    expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalled();
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
});

// --- detectVideoType unit tests ---

describe('detectVideoType', () => {
  it('detects WebM by EBML magic bytes', () => {
    expect(detectVideoType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00]))).toBe('webm');
  });

  it('detects MP4 by ftyp box at bytes 4–7', () => {
    expect(detectVideoType(Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]))).toBe('mp4');
  });

  it('returns null for unrecognised bytes', () => {
    expect(detectVideoType(Buffer.from('not a video'))).toBeNull();
  });

  it('returns null for a buffer that is too short', () => {
    expect(detectVideoType(Buffer.from([0x1a, 0x45]))).toBeNull();
  });
});

// --- handleUploadError unit tests ---

describe('handleUploadError', () => {
  /** Minimal Express response stub capturing the redirect target. */
  function makeRes() {
    return { redirect: vi.fn() } as any;
  }

  it('returns false and does not redirect when there is no error', () => {
    const res = makeRes();
    expect(handleUploadError(null, res)).toBe(false);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('redirects oversized files to file_too_large', () => {
    const res = makeRes();
    const err = new multer.MulterError('LIMIT_FILE_SIZE', 'video');
    expect(handleUploadError(err, res)).toBe(true);
    expect(res.redirect).toHaveBeenCalledWith('/overlay/settings?error=file_too_large');
  });

  it('redirects other multer/unknown errors to upload_failed', () => {
    const res = makeRes();
    expect(handleUploadError(new Error('boom'), res)).toBe(true);
    expect(res.redirect).toHaveBeenCalledWith('/overlay/settings?error=upload_failed');
  });
});
