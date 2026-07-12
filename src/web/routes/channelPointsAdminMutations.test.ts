import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  updatePricingCooldownForReward: vi.fn(),
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

vi.mock('../../twitch/twitchApi', () => ({
  createCustomReward: vi.fn(),
  updateCustomReward: vi.fn(),
}));

vi.mock('../../twitch/eventsub/twitchApiEventSub', () => ({
  getValidToken: vi.fn(),
}));

vi.mock('../../twitch/pricing/rewardPricingService', () => ({
  deleteRewardAndPricing: vi.fn().mockResolvedValue(undefined),
}));

// This module composes channelPointsAdminPricingMutations's router too; stub it out so this
// file only exercises the reward-CRUD routes defined directly in channelPointsAdminMutations.
vi.mock('./channelPointsAdminPricingMutations', async () => {
  const { Router } = await import('express');
  return { router: Router() };
});

import supertest from 'supertest';
import { router } from './channelPointsAdminMutations';
import { getStreamerByDiscordId, updatePricingCooldownForReward } from '../../db';
import { createCustomReward, updateCustomReward } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';
import { deleteRewardAndPricing } from '../../twitch/pricing/rewardPricingService';
import { buildTestApp } from '../../test-utils/expressTestApp';

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3; isOwner: boolean };
const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: 0, isOwner: false };

const MOCK_STREAMER = { id: 123, twitch_user_id: 'twitch123', twitch_name: 'teststreamer', discord_id: USER.discordId };

const VALID_REWARD_ID = '12345678-1234-1234-8234-123456789abc';

const VALID_REWARD_FORM = {
  title: 'Cool Reward', cost: '200', prompt: '', background_color: '',
};

/** Builds a supertest-ready app: the channel points admin mutations router with a stubbed session (no render stub — these routes redirect). */
function buildApp(sessionUser: SessionUser = USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser });
}

const VALID_REWARD_TWITCH_DATA = { id: VALID_REWARD_ID, global_cooldown_setting: { is_enabled: true, global_cooldown_seconds: 300 } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  vi.mocked(getValidToken).mockResolvedValue('user-token');
  vi.mocked(createCustomReward).mockResolvedValue(VALID_REWARD_TWITCH_DATA as any);
  vi.mocked(updateCustomReward).mockResolvedValue(VALID_REWARD_TWITCH_DATA as any);
  vi.mocked(updatePricingCooldownForReward).mockResolvedValue(undefined);
  vi.mocked(deleteRewardAndPricing).mockResolvedValue(undefined);
});

describe('POST /rewards', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp()).post('/rewards').type('form').send(VALID_REWARD_FORM);
    expect(res.headers.location).toBe('/channel-points?error=not_a_streamer');
  });

  it.each([
    ['missing title', { title: '' }],
    ['missing cost', { cost: '' }],
    ['non-positive cost', { cost: '0' }],
    ['user input required with no prompt', { is_user_input_required: 'on', prompt: '' }],
    ['max-per-stream enabled with no value', { is_max_per_stream_enabled: 'on', max_per_stream: '' }],
  ])('redirects with invalid_reward_fields when %s', async (_name, override) => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/rewards').type('form').send({ ...VALID_REWARD_FORM, ...override });
    expect(res.headers.location).toBe('/channel-points?error=invalid_reward_fields');
    expect(createCustomReward).not.toHaveBeenCalled();
  });

  it('creates the reward and redirects to success', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/rewards').type('form').send(VALID_REWARD_FORM);
    expect(res.headers.location).toBe('/channel-points?success=reward_created');
    expect(createCustomReward).toHaveBeenCalledWith('twitch123', 'user-token', expect.objectContaining({
      title: 'Cool Reward', cost: 200,
    }));
  });

  it('redirects with create_failed when no valid token is available', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(getValidToken).mockResolvedValue(null);
    const res = await supertest(buildApp()).post('/rewards').type('form').send(VALID_REWARD_FORM);
    expect(res.headers.location).toBe('/channel-points?error=create_failed');
    expect(createCustomReward).not.toHaveBeenCalled();
  });

  it('redirects with create_failed when createCustomReward throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(createCustomReward).mockRejectedValueOnce(new Error('Twitch down'));
    const res = await supertest(buildApp()).post('/rewards').type('form').send(VALID_REWARD_FORM);
    expect(res.headers.location).toBe('/channel-points?error=create_failed');
  });
});

describe('POST /rewards/:twitchRewardId', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp()).post(`/rewards/${VALID_REWARD_ID}`).type('form').send(VALID_REWARD_FORM);
    expect(res.headers.location).toBe('/channel-points?error=not_a_streamer');
  });

  it('redirects with error for an invalid reward id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/rewards/not-a-uuid').type('form').send(VALID_REWARD_FORM);
    expect(res.headers.location).toBe('/channel-points?error=invalid_reward_id');
  });

  it('redirects with invalid_reward_fields for an invalid field', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post(`/rewards/${VALID_REWARD_ID}`).type('form').send({ ...VALID_REWARD_FORM, title: '' });
    expect(res.headers.location).toBe('/channel-points?error=invalid_reward_fields');
  });

  it('updates the reward, syncs the pricing cooldown to match, and redirects to success', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post(`/rewards/${VALID_REWARD_ID}`).type('form').send(VALID_REWARD_FORM);
    expect(res.headers.location).toBe('/channel-points?success=reward_updated');
    expect(updateCustomReward).toHaveBeenCalledWith('twitch123', VALID_REWARD_ID, 'user-token', expect.objectContaining({
      title: 'Cool Reward', cost: 200,
    }));
    expect(updatePricingCooldownForReward).toHaveBeenCalledWith(MOCK_STREAMER.id, VALID_REWARD_ID, 300);
  });

  it('still redirects to success when the best-effort cooldown sync throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(updatePricingCooldownForReward).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp()).post(`/rewards/${VALID_REWARD_ID}`).type('form').send(VALID_REWARD_FORM);
    expect(res.headers.location).toBe('/channel-points?success=reward_updated');
  });

  it('redirects with update_failed when no valid token is available', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(getValidToken).mockResolvedValue(null);
    const res = await supertest(buildApp()).post(`/rewards/${VALID_REWARD_ID}`).type('form').send(VALID_REWARD_FORM);
    expect(res.headers.location).toBe('/channel-points?error=update_failed');
  });

  it('redirects with update_failed when updateCustomReward throws (e.g. a 403 for a reward this app did not create)', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(updateCustomReward).mockRejectedValueOnce(new Error('403'));
    const res = await supertest(buildApp()).post(`/rewards/${VALID_REWARD_ID}`).type('form').send(VALID_REWARD_FORM);
    expect(res.headers.location).toBe('/channel-points?error=update_failed');
  });
});

describe('POST /rewards/:twitchRewardId/delete', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp()).post(`/rewards/${VALID_REWARD_ID}/delete`);
    expect(res.headers.location).toBe('/channel-points?error=not_a_streamer');
  });

  it('redirects with error for an invalid reward id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/rewards/not-a-uuid/delete');
    expect(res.headers.location).toBe('/channel-points?error=invalid_reward_id');
  });

  it('deletes the reward and redirects to success', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post(`/rewards/${VALID_REWARD_ID}/delete`);
    expect(res.headers.location).toBe('/channel-points?success=reward_deleted');
    expect(deleteRewardAndPricing).toHaveBeenCalledWith(MOCK_STREAMER.id, VALID_REWARD_ID);
  });

  it('redirects with delete_failed when deleteRewardAndPricing throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(deleteRewardAndPricing).mockRejectedValueOnce(new Error('403'));
    const res = await supertest(buildApp()).post(`/rewards/${VALID_REWARD_ID}/delete`);
    expect(res.headers.location).toBe('/channel-points?error=delete_failed');
  });
});
