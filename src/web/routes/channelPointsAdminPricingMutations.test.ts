import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  upsertPricingConfig: vi.fn(),
  getPricingForReward: vi.fn(),
  savePricingSettingsForStreamer: vi.fn(),
  DEFAULT_PRICING_COOLDOWN_SECONDS: 60,
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
  getCustomRewards: vi.fn(),
}));

vi.mock('../../twitch/eventsub/twitchApiEventSub', () => ({
  getValidToken: vi.fn(),
}));

vi.mock('../../twitch/pricing/rewardPricingService', () => ({
  applyDecayTick: vi.fn().mockResolvedValue(undefined),
  resetAndDeletePricing: vi.fn().mockResolvedValue(undefined),
}));

import supertest from 'supertest';
import { router } from './channelPointsAdminPricingMutations';
import { getStreamerByDiscordId, upsertPricingConfig, getPricingForReward, savePricingSettingsForStreamer } from '../../db';
import { getCustomRewards } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';
import { applyDecayTick, resetAndDeletePricing } from '../../twitch/pricing/rewardPricingService';
import { buildTestApp } from '../../test-utils/expressTestApp';

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3; isOwner: boolean };
const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: 0, isOwner: false };

const MOCK_STREAMER = { id: 123, twitch_user_id: 'twitch123', twitch_name: 'teststreamer', discord_id: USER.discordId };

const VALID_REWARD_ID = '12345678-1234-1234-8234-123456789abc';
const VALID_REWARD_TWITCH_DATA = { id: VALID_REWARD_ID, global_cooldown_setting: { is_enabled: true, global_cooldown_seconds: 300 } };

/** Builds a supertest-ready app: the channel points pricing mutations router with a stubbed session (no render stub — these routes redirect). */
function buildApp(sessionUser: SessionUser = USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  vi.mocked(getValidToken).mockResolvedValue('user-token');
  vi.mocked(getCustomRewards).mockResolvedValue([VALID_REWARD_TWITCH_DATA as any]);
  vi.mocked(getPricingForReward).mockResolvedValue(null);
  vi.mocked(upsertPricingConfig).mockResolvedValue(undefined);
  vi.mocked(savePricingSettingsForStreamer).mockResolvedValue(undefined);
  vi.mocked(applyDecayTick).mockResolvedValue(undefined);
  vi.mocked(resetAndDeletePricing).mockResolvedValue(undefined);
});

describe('POST /rewards/:twitchRewardId/pricing', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp())
      .post(`/rewards/${VALID_REWARD_ID}/pricing`)
      .type('form')
      .send({ base_cost: '200', max_multiplier: '4', curve: '1.5' });
    expect(res.headers.location).toBe('/channel-points?error=not_a_streamer');
  });

  it('redirects with error for an invalid reward id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/rewards/not-a-uuid/pricing')
      .type('form')
      .send({ base_cost: '200', max_multiplier: '4', curve: '1.5' });
    expect(res.headers.location).toBe('/channel-points?error=invalid_reward_id');
  });

  it.each([
    ['base_cost', { base_cost: '0' }],
    ['max_multiplier', { max_multiplier: '-1' }],
    ['curve', { curve: '0' }],
  ])('redirects with invalid_config when %s is invalid', async (_name, override) => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post(`/rewards/${VALID_REWARD_ID}/pricing`)
      .type('form')
      .send({ base_cost: '200', max_multiplier: '4', curve: '1.5', ...override });
    expect(res.headers.location).toBe('/channel-points?error=invalid_config');
  });

  it('saves the config using the reward\'s live Twitch cooldown, best-effort resyncs, and redirects to success', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post(`/rewards/${VALID_REWARD_ID}/pricing`)
      .type('form')
      .send({ enabled: 'on', base_cost: '200', max_multiplier: '4', curve: '1.5' });
    expect(res.headers.location).toBe('/channel-points?success=pricing_saved');
    expect(upsertPricingConfig).toHaveBeenCalledWith(MOCK_STREAMER.id, VALID_REWARD_ID, {
      enabled: true, base_cost: 200, cooldown_seconds: 300, max_multiplier: 4, curve: 1.5, round_to_nearest: 0,
    });
    expect(applyDecayTick).toHaveBeenCalledWith(MOCK_STREAMER.id, VALID_REWARD_ID);
  });

  it('defaults round_to_nearest to 0 (off) when not sent', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    await supertest(buildApp())
      .post(`/rewards/${VALID_REWARD_ID}/pricing`)
      .type('form')
      .send({ base_cost: '200', max_multiplier: '4', curve: '1.5' });
    expect(upsertPricingConfig).toHaveBeenCalledWith(MOCK_STREAMER.id, VALID_REWARD_ID, expect.objectContaining({ round_to_nearest: 0 }));
  });

  it('saves a configured round_to_nearest value', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    await supertest(buildApp())
      .post(`/rewards/${VALID_REWARD_ID}/pricing`)
      .type('form')
      .send({ base_cost: '200', max_multiplier: '4', curve: '1.5', round_to_nearest: '10' });
    expect(upsertPricingConfig).toHaveBeenCalledWith(MOCK_STREAMER.id, VALID_REWARD_ID, expect.objectContaining({ round_to_nearest: 10 }));
  });

  it('redirects with invalid_config when round_to_nearest is outside {0, 5, 10}', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post(`/rewards/${VALID_REWARD_ID}/pricing`)
      .type('form')
      .send({ base_cost: '200', max_multiplier: '4', curve: '1.5', round_to_nearest: '7' });
    expect(res.headers.location).toBe('/channel-points?error=invalid_config');
    expect(upsertPricingConfig).not.toHaveBeenCalled();
  });

  it('falls back to the existing pricing config cooldown when the reward is no longer found on Twitch', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(getCustomRewards).mockResolvedValue([]);
    vi.mocked(getPricingForReward).mockResolvedValue({ cooldown_seconds: 120 } as any);
    await supertest(buildApp())
      .post(`/rewards/${VALID_REWARD_ID}/pricing`)
      .type('form')
      .send({ base_cost: '200', max_multiplier: '4', curve: '1.5' });
    expect(upsertPricingConfig).toHaveBeenCalledWith(MOCK_STREAMER.id, VALID_REWARD_ID, expect.objectContaining({ cooldown_seconds: 120 }));
  });

  it('falls back to the default cooldown when the reward is unknown and no pricing config exists yet', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(getCustomRewards).mockResolvedValue([]);
    vi.mocked(getPricingForReward).mockResolvedValue(null);
    await supertest(buildApp())
      .post(`/rewards/${VALID_REWARD_ID}/pricing`)
      .type('form')
      .send({ base_cost: '200', max_multiplier: '4', curve: '1.5' });
    expect(upsertPricingConfig).toHaveBeenCalledWith(MOCK_STREAMER.id, VALID_REWARD_ID, expect.objectContaining({ cooldown_seconds: 60 }));
  });

  it('falls back to the existing pricing config cooldown when the live Twitch lookup throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(getCustomRewards).mockRejectedValueOnce(new Error('Twitch down'));
    vi.mocked(getPricingForReward).mockResolvedValue({ cooldown_seconds: 90 } as any);
    await supertest(buildApp())
      .post(`/rewards/${VALID_REWARD_ID}/pricing`)
      .type('form')
      .send({ base_cost: '200', max_multiplier: '4', curve: '1.5' });
    expect(upsertPricingConfig).toHaveBeenCalledWith(MOCK_STREAMER.id, VALID_REWARD_ID, expect.objectContaining({ cooldown_seconds: 90 }));
  });

  it('treats a missing enabled checkbox as false', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    await supertest(buildApp())
      .post(`/rewards/${VALID_REWARD_ID}/pricing`)
      .type('form')
      .send({ base_cost: '200', max_multiplier: '4', curve: '1.5' });
    expect(upsertPricingConfig).toHaveBeenCalledWith(MOCK_STREAMER.id, VALID_REWARD_ID, expect.objectContaining({ enabled: false }));
  });

  it('still redirects to success when the best-effort resync throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(applyDecayTick).mockRejectedValueOnce(new Error('twitch down'));
    const res = await supertest(buildApp())
      .post(`/rewards/${VALID_REWARD_ID}/pricing`)
      .type('form')
      .send({ base_cost: '200', max_multiplier: '4', curve: '1.5' });
    expect(res.headers.location).toBe('/channel-points?success=pricing_saved');
  });

  it('redirects with save_failed when upsertPricingConfig throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(upsertPricingConfig).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp())
      .post(`/rewards/${VALID_REWARD_ID}/pricing`)
      .type('form')
      .send({ base_cost: '200', max_multiplier: '4', curve: '1.5' });
    expect(res.headers.location).toBe('/channel-points?error=save_failed');
  });
});

describe('POST /rewards/:twitchRewardId/pricing/delete', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp()).post(`/rewards/${VALID_REWARD_ID}/pricing/delete`);
    expect(res.headers.location).toBe('/channel-points?error=not_a_streamer');
  });

  it('redirects with error for an invalid reward id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/rewards/not-a-uuid/pricing/delete');
    expect(res.headers.location).toBe('/channel-points?error=invalid_reward_id');
  });

  it('disables pricing and redirects to success', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post(`/rewards/${VALID_REWARD_ID}/pricing/delete`);
    expect(res.headers.location).toBe('/channel-points?success=pricing_deleted');
    expect(resetAndDeletePricing).toHaveBeenCalledWith(MOCK_STREAMER.id, VALID_REWARD_ID);
  });

  it('redirects with delete_failed when resetAndDeletePricing throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(resetAndDeletePricing).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp()).post(`/rewards/${VALID_REWARD_ID}/pricing/delete`);
    expect(res.headers.location).toBe('/channel-points?error=delete_failed');
  });
});

describe('POST /settings/pricing', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp(USER))
      .post('/settings/pricing')
      .type('form')
      .send({ half_life_minutes: '30', time_to_max_multiplier: '2' });
    expect(res.headers.location).toBe('/channel-points?error=not_a_streamer');
    expect(savePricingSettingsForStreamer).not.toHaveBeenCalled();
  });

  it('rejects an invalid half_life_minutes', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/pricing')
      .type('form')
      .send({ half_life_minutes: '0', time_to_max_multiplier: '2' });
    expect(res.headers.location).toBe('/channel-points?error=invalid_settings');
  });

  it('rejects a half_life_minutes so small it would round down to 0 seconds', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/pricing')
      .type('form')
      .send({ half_life_minutes: '0.001', time_to_max_multiplier: '2' });
    expect(res.headers.location).toBe('/channel-points?error=invalid_settings');
    expect(savePricingSettingsForStreamer).not.toHaveBeenCalled();
  });

  it('rejects an invalid time_to_max_multiplier', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/pricing')
      .type('form')
      .send({ half_life_minutes: '30', time_to_max_multiplier: '0' });
    expect(res.headers.location).toBe('/channel-points?error=invalid_settings');
  });

  it('saves the settings converted to seconds and redirects to success', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/pricing')
      .type('form')
      .send({ half_life_minutes: '30', time_to_max_multiplier: '2' });
    expect(res.headers.location).toBe('/channel-points?success=pricing_settings_saved');
    expect(savePricingSettingsForStreamer).toHaveBeenCalledWith(MOCK_STREAMER.id, { half_life_seconds: 1800, time_to_max_multiplier: 2 });
  });

  it('redirects with save_failed when savePricingSettingsForStreamer throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(savePricingSettingsForStreamer).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp())
      .post('/settings/pricing')
      .type('form')
      .send({ half_life_minutes: '30', time_to_max_multiplier: '2' });
    expect(res.headers.location).toBe('/channel-points?error=save_failed');
  });
});
