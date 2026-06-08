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
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  },
}));

vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../shared/config', () => ({
  OVERLAY_FOLDER: '/app/overlay-videos',
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

import express from 'express';
import supertest from 'supertest';
import { router, detectVideoType } from './overlayAdminMutations';
import { getStreamerByDiscordId, addVideo, deleteVideo } from '../../db';
import { AccessLevel } from '../../db/users';
import fs from 'fs';

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

function buildApp(sessionUser: SessionUser = USER) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req: any, res: any, next: any) => {
    req.session = { user: sessionUser };
    next();
  });
  app.use(router);
  return app;
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
