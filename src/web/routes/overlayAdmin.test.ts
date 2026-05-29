import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  getVideosForStreamer: vi.fn(),
  addVideo: vi.fn(),
  deleteVideo: vi.fn(),
  getRewardsForStreamer: vi.fn(),
  upsertReward: vi.fn(),
  setRewardVideos: vi.fn(),
  deleteReward: vi.fn(),
}));

vi.mock('../../twitchApi', () => ({
  getCustomRewards: vi.fn(),
}));

vi.mock('../../twitchApiEventSub', () => ({
  getValidToken: vi.fn(),
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

vi.mock('../../config', () => ({
  OVERLAY_FOLDER: '/app/overlay-videos',
  PUBLIC_URL: 'https://example.com',
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
import router from './overlayAdmin';
import { getStreamerByDiscordId, addVideo, deleteVideo } from '../../db';
import fs from 'fs';

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3 };

const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: 0 };

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
    res.render = (view: string, locals?: any) => res.json({ view, ...locals });
    next();
  });
  app.use(router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  vi.mocked(addVideo).mockResolvedValue(undefined);
  vi.mocked(deleteVideo).mockResolvedValue(null);
  vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);
  vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);
  vi.mocked(fs.promises.rm).mockResolvedValue(undefined);
});

// --- GET /settings ---

describe('GET /settings', () => {
  it('renders the overlayAdmin view on success', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).get('/settings');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('overlayAdmin');
  });

  it('passes error query param to the template', async () => {
    const res = await supertest(buildApp()).get('/settings?error=invalid_path');
    expect(res.status).toBe(200);
    expect(res.body.error).toBe('invalid_path');
  });
});

// --- POST /settings/videos/upload ---

describe('POST /settings/videos/upload', () => {
  it('redirects with error when user is not a streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
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

  it('successfully uploads a valid video file', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', Buffer.from('fake video'), { filename: 'test.mp4', contentType: 'video/mp4' });
    
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
    expect(vi.mocked(fs.promises.mkdir)).toHaveBeenCalled();
    expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalled();
    expect(vi.mocked(addVideo)).toHaveBeenCalled();
  });
});

// --- Path Traversal Security Tests ---

describe('POST /settings/videos/upload - Path Traversal Protection', () => {
  beforeEach(() => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
  });

  it('blocks path traversal attempt with ../ in streamer ID', async () => {
    // Mock a streamer with a malicious ID containing path traversal
    const maliciousStreamer = { ...MOCK_STREAMER, id: '../../../etc/passwd' as any };
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(maliciousStreamer as any);

    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', Buffer.from('fake video'), { filename: 'test.mp4', contentType: 'video/mp4' });

    // Should reject the path traversal attempt
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_path');
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });

  it('blocks absolute path in streamer ID', async () => {
    // Mock a streamer with an absolute path as ID
    const maliciousStreamer = { ...MOCK_STREAMER, id: '/etc/passwd' as any };
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(maliciousStreamer as any);

    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', Buffer.from('fake video'), { filename: 'test.mp4', contentType: 'video/mp4' });

    // Should reject the absolute path
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_path');
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });

  it('blocks path traversal with encoded characters', async () => {
    // Mock a streamer with URL-encoded path traversal
    const maliciousStreamer = { ...MOCK_STREAMER, id: '..%2F..%2Fetc%2Fpasswd' as any };
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(maliciousStreamer as any);

    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', Buffer.from('fake video'), { filename: 'test.mp4', contentType: 'video/mp4' });

    // Should reject the encoded path traversal
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_path');
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(addVideo)).not.toHaveBeenCalled();
  });

  it('allows valid numeric streamer ID', async () => {
    // Normal case with a valid numeric ID
    const validStreamer = { ...MOCK_STREAMER, id: 456 };
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(validStreamer as any);

    const res = await supertest(buildApp())
      .post('/settings/videos/upload')
      .field('name', 'Test Video')
      .attach('video', Buffer.from('fake video'), { filename: 'test.mp4', contentType: 'video/mp4' });

    // Should succeed
    expect(res.headers.location).toBe('/overlay/settings?success=video_uploaded');
    expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalled();
    expect(vi.mocked(addVideo)).toHaveBeenCalled();
  });

  it('validates that resolved path stays within base directory', async () => {
    // Test the actual path validation logic
    const base = path.resolve('/app/overlay-videos');
    
    // Valid case: numeric ID
    const validDir = path.resolve(base, '123');
    const validRelative = path.relative(base, validDir);
    expect(validRelative.startsWith('..')).toBe(false);
    expect(path.isAbsolute(validRelative)).toBe(false);

    // Invalid case: path traversal
    const invalidDir = path.resolve(base, '../../../etc/passwd');
    const invalidRelative = path.relative(base, invalidDir);
    expect(invalidRelative.startsWith('..')).toBe(true);

    // Invalid case: absolute path
    const absoluteDir = path.resolve(base, '/etc/passwd');
    const absoluteRelative = path.relative(base, absoluteDir);
    expect(absoluteRelative.startsWith('..') || path.isAbsolute(absoluteRelative)).toBe(true);
  });
});

// --- POST /settings/videos/:id/delete ---

describe('POST /settings/videos/:id/delete', () => {
  it('redirects with error when user is not a streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const res = await supertest(buildApp()).post('/settings/videos/1/delete');
    expect(res.headers.location).toBe('/overlay/settings?error=not_a_streamer');
  });

  it('redirects with error for invalid video ID', async () => {
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
});

// --- POST /settings/rewards ---

describe('POST /settings/rewards', () => {
  it('redirects with error when user is not a streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const res = await supertest(buildApp())
      .post('/settings/rewards')
      .type('form')
      .send({ twitch_reward_id: '12345678-1234-1234-1234-123456789abc', video_ids: ['1'] });
    expect(res.headers.location).toBe('/overlay/settings?error=not_a_streamer');
  });

  it('redirects with error for invalid reward ID format', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/rewards')
      .type('form')
      .send({ twitch_reward_id: 'invalid-id', video_ids: ['1'] });
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_reward_id');
  });

  it('redirects with error when no videos are selected', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/rewards')
      .type('form')
      .send({ twitch_reward_id: '12345678-1234-1234-1234-123456789abc', video_ids: [] });
    expect(res.headers.location).toBe('/overlay/settings?error=no_videos_selected');
  });
});

// --- POST /settings/rewards/:id/delete ---

describe('POST /settings/rewards/:id/delete', () => {
  it('redirects with error when user is not a streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const res = await supertest(buildApp()).post('/settings/rewards/1/delete');
    expect(res.headers.location).toBe('/overlay/settings?error=not_a_streamer');
  });

  it('redirects with error for invalid reward ID', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/settings/rewards/invalid/delete');
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_id');
  });
});
