import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
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

vi.mock('../../config', () => ({
  OVERLAY_FOLDER: '/app/overlay-videos',
  PUBLIC_URL: 'https://example.com',
}));

vi.mock('../../db/users', () => ({ AccessLevel: ACCESS_LEVEL_MOCK }));

import express from 'express';
import supertest from 'supertest';
import { router } from './overlayAdminRewardMutations';
import { getStreamerByDiscordId, upsertReward, setRewardVideos, deleteReward } from '../../db';
import { AccessLevel } from '../../db/users';

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
  vi.mocked(upsertReward).mockResolvedValue(99);
  vi.mocked(setRewardVideos).mockResolvedValue(undefined);
  vi.mocked(deleteReward).mockResolvedValue(undefined);
});

// --- POST /settings/rewards ---

describe('POST /settings/rewards', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp())
      .post('/settings/rewards')
      .type('form')
      .send({ twitch_reward_id: '12345678-1234-1234-8234-123456789abc', video_ids: ['1'] });
    expect(res.headers.location).toBe('/overlay/settings?error=not_a_streamer');
  });

  it('redirects with error for invalid reward id format', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/rewards')
      .type('form')
      .send({ twitch_reward_id: 'invalid-id', video_ids: ['1'] });
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_reward_id');
  });

  it('redirects with error for all-hyphens string that passes loose regex', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/rewards')
      .type('form')
      .send({ twitch_reward_id: '------------------------------------', video_ids: ['1'] });
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_reward_id');
  });

  it('redirects with error when no videos selected', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/rewards')
      .type('form')
      .send({ twitch_reward_id: '12345678-1234-1234-8234-123456789abc' });
    expect(res.headers.location).toBe('/overlay/settings?error=no_videos_selected');
  });

  it('saves a reward and redirects to success', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(upsertReward).mockResolvedValue(42);
    const res = await supertest(buildApp())
      .post('/settings/rewards')
      .type('form')
      .send({ twitch_reward_id: '12345678-1234-1234-8234-123456789abc', video_ids: ['7', '8'], weight_7: '3', weight_8: '1' });
    expect(res.headers.location).toBe('/overlay/settings?success=reward_saved');
    expect(vi.mocked(upsertReward)).toHaveBeenCalledWith(MOCK_STREAMER.id, '12345678-1234-1234-8234-123456789abc');
    expect(vi.mocked(setRewardVideos)).toHaveBeenCalledWith(
      42,
      MOCK_STREAMER.id,
      [{ videoId: 7, weight: 3 }, { videoId: 8, weight: 1 }],
    );
  });
});

// --- POST /settings/rewards/:id/delete ---

describe('POST /settings/rewards/:id/delete', () => {
  it('redirects with error for invalid reward id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/settings/rewards/invalid/delete');
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_id');
  });

  it('deletes a reward and redirects to success', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/settings/rewards/5/delete');
    expect(res.headers.location).toBe('/overlay/settings?success=reward_deleted');
    expect(vi.mocked(deleteReward)).toHaveBeenCalledWith(5, MOCK_STREAMER.id);
  });
});
