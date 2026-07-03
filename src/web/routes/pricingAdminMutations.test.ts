import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  upsertPricingConfig: vi.fn(),
  deletePricingConfig: vi.fn(),
  saveGlobalPricingSettings: vi.fn(),
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

vi.mock('../../twitch/pricing/rewardPricingService', () => ({ applyDecayTick: vi.fn().mockResolvedValue(undefined) }));

import express from 'express';
import supertest from 'supertest';
import { router } from './pricingAdminMutations';
import { getStreamerByDiscordId, upsertPricingConfig, deletePricingConfig, saveGlobalPricingSettings } from '../../db';
import { applyDecayTick } from '../../twitch/pricing/rewardPricingService';

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3; isOwner: boolean };
const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: 0, isOwner: false };
const OWNER: SessionUser = { ...USER, discordId: '200000000000000002', isOwner: true };

const MOCK_STREAMER = { id: 123, twitch_user_id: 'twitch123', twitch_name: 'teststreamer', discord_id: USER.discordId };

const VALID_REWARD_ID = '12345678-1234-1234-8234-123456789abc';

function buildApp(sessionUser: SessionUser = USER) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req: any, _res: any, next: any) => {
    req.session = { user: sessionUser };
    next();
  });
  app.use(router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  vi.mocked(upsertPricingConfig).mockResolvedValue(undefined);
  vi.mocked(deletePricingConfig).mockResolvedValue(undefined);
  vi.mocked(saveGlobalPricingSettings).mockResolvedValue(undefined);
});

describe('POST /settings/rewards', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp())
      .post('/settings/rewards')
      .type('form')
      .send({ twitch_reward_id: VALID_REWARD_ID, base_cost: '200', cooldown_seconds: '300', max_multiplier: '4', curve: '1.5' });
    expect(res.headers.location).toBe('/pricing?error=not_a_streamer');
  });

  it('redirects with error for an invalid reward id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/rewards')
      .type('form')
      .send({ twitch_reward_id: 'not-a-uuid', base_cost: '200', cooldown_seconds: '300', max_multiplier: '4', curve: '1.5' });
    expect(res.headers.location).toBe('/pricing?error=invalid_reward_id');
  });

  it.each([
    ['base_cost', { base_cost: '0' }],
    ['cooldown_seconds', { cooldown_seconds: '0' }],
    ['max_multiplier', { max_multiplier: '-1' }],
    ['curve', { curve: '0' }],
  ])('redirects with invalid_config when %s is invalid', async (_name, override) => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/rewards')
      .type('form')
      .send({
        twitch_reward_id: VALID_REWARD_ID,
        base_cost: '200', cooldown_seconds: '300', max_multiplier: '4', curve: '1.5',
        ...override,
      });
    expect(res.headers.location).toBe('/pricing?error=invalid_config');
  });

  it('saves the config, best-effort resyncs, and redirects to success', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/rewards')
      .type('form')
      .send({
        twitch_reward_id: VALID_REWARD_ID,
        enabled: 'on',
        base_cost: '200', cooldown_seconds: '300', max_multiplier: '4', curve: '1.5',
      });
    expect(res.headers.location).toBe('/pricing?success=pricing_saved');
    expect(upsertPricingConfig).toHaveBeenCalledWith(MOCK_STREAMER.id, VALID_REWARD_ID, {
      enabled: true, base_cost: 200, cooldown_seconds: 300, max_multiplier: 4, curve: 1.5,
    });
    expect(applyDecayTick).toHaveBeenCalledWith(MOCK_STREAMER.id, VALID_REWARD_ID);
  });

  it('treats a missing enabled checkbox as false', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    await supertest(buildApp())
      .post('/settings/rewards')
      .type('form')
      .send({ twitch_reward_id: VALID_REWARD_ID, base_cost: '200', cooldown_seconds: '300', max_multiplier: '4', curve: '1.5' });
    expect(upsertPricingConfig).toHaveBeenCalledWith(MOCK_STREAMER.id, VALID_REWARD_ID, expect.objectContaining({ enabled: false }));
  });

  it('still redirects to success when the best-effort resync throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(applyDecayTick).mockRejectedValueOnce(new Error('twitch down'));
    const res = await supertest(buildApp())
      .post('/settings/rewards')
      .type('form')
      .send({ twitch_reward_id: VALID_REWARD_ID, base_cost: '200', cooldown_seconds: '300', max_multiplier: '4', curve: '1.5' });
    expect(res.headers.location).toBe('/pricing?success=pricing_saved');
  });
});

describe('POST /settings/rewards/:id/delete', () => {
  it('redirects with error for an invalid id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/settings/rewards/invalid/delete');
    expect(res.headers.location).toBe('/pricing?error=invalid_id');
  });

  it('deletes and redirects to success', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/settings/rewards/5/delete');
    expect(res.headers.location).toBe('/pricing?success=pricing_deleted');
    expect(deletePricingConfig).toHaveBeenCalledWith(5, MOCK_STREAMER.id);
  });
});

describe('POST /settings/global', () => {
  it('rejects a non-owner even without checking guild access level', async () => {
    const res = await supertest(buildApp(USER))
      .post('/settings/global')
      .type('form')
      .send({ decay_half_life_periods: '3', redemption_increment: '0.1' });
    expect(res.headers.location).toBe('/pricing?error=not_owner');
    expect(saveGlobalPricingSettings).not.toHaveBeenCalled();
  });

  it('rejects an invalid decay_half_life_periods for an owner', async () => {
    const res = await supertest(buildApp(OWNER))
      .post('/settings/global')
      .type('form')
      .send({ decay_half_life_periods: '0', redemption_increment: '0.1' });
    expect(res.headers.location).toBe('/pricing?error=invalid_settings');
  });

  it('rejects a redemption_increment above 1', async () => {
    const res = await supertest(buildApp(OWNER))
      .post('/settings/global')
      .type('form')
      .send({ decay_half_life_periods: '3', redemption_increment: '1.5' });
    expect(res.headers.location).toBe('/pricing?error=invalid_settings');
  });

  it('saves and redirects to success for an owner', async () => {
    const res = await supertest(buildApp(OWNER))
      .post('/settings/global')
      .type('form')
      .send({ decay_half_life_periods: '4', redemption_increment: '0.2' });
    expect(res.headers.location).toBe('/pricing?success=global_settings_saved');
    expect(saveGlobalPricingSettings).toHaveBeenCalledWith({ decay_half_life_periods: 4, redemption_increment: 0.2 });
  });
});
