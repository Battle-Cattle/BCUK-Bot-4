import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  getPricingConfigsForStreamer: vi.fn(),
  getGlobalPricingSettings: vi.fn(),
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

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('./pricingAdminMutations', async () => {
  const { Router } = await import('express');
  return { router: Router() };
});

import express from 'express';
import supertest from 'supertest';
import router from './pricingAdmin';
import { getStreamerByDiscordId, getPricingConfigsForStreamer, getGlobalPricingSettings } from '../../db';
import { getCustomRewards } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3; isOwner: boolean };
const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: 0, isOwner: false };
const OWNER: SessionUser = { ...USER, discordId: '200000000000000002', isOwner: true };

const MOCK_STREAMER = { id: 123, twitch_user_id: 'twitch123', twitch_name: 'teststreamer', discord_id: USER.discordId };

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
  vi.mocked(getPricingConfigsForStreamer).mockResolvedValue([]);
  vi.mocked(getCustomRewards).mockResolvedValue([]);
  vi.mocked(getValidToken).mockResolvedValue('token');
  vi.mocked(getGlobalPricingSettings).mockResolvedValue({ decay_half_life_periods: 3, redemption_increment: 0.1 });
});

describe('GET /', () => {
  it('renders with streamer=null when the user is not a streamer', async () => {
    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.streamer).toBeNull();
  });

  it('returns 500 when getStreamerByDiscordId throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(500);
  });

  it('merges live Twitch rewards with existing pricing config and computes a preview price', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(getCustomRewards).mockResolvedValue([{ id: 'rwd1', title: 'Cool Reward', cost: 200, is_enabled: true } as any]);
    vi.mocked(getPricingConfigsForStreamer).mockResolvedValue([{
      id: 1, streamer_id: 123, twitch_reward_id: 'rwd1', enabled: true,
      base_cost: 200, cooldown_seconds: 300, max_multiplier: 4, curve: 1.5,
      demand: 1, demand_updated_at: '1700000000000', last_pushed_cost: 1000, twitch_unsupported: false,
    }] as any);

    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.rewards).toHaveLength(1);
    expect(res.body.rewards[0].config.id).toBe(1);
    expect(res.body.rewards[0].previewPrice).toBe(1000);
  });

  it('renders with an empty reward list when getCustomRewards throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(getCustomRewards).mockRejectedValue(new Error('Twitch down'));

    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.rewards).toEqual([]);
  });

  it('renders with an empty reward list (not a 500) when getValidToken throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(getValidToken).mockRejectedValue(new Error('token refresh failed'));

    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.rewards).toEqual([]);
    expect(getCustomRewards).not.toHaveBeenCalled();
  });

  it('surfaces a pricing config as an unlinked row when its reward no longer appears on Twitch', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(getCustomRewards).mockResolvedValue([]); // reward no longer listed by Twitch
    vi.mocked(getPricingConfigsForStreamer).mockResolvedValue([{
      id: 1, streamer_id: 123, twitch_reward_id: 'orphaned-rwd', enabled: true,
      base_cost: 200, cooldown_seconds: 300, max_multiplier: 4, curve: 1.5,
      demand: 0.5, demand_updated_at: '1700000000000', last_pushed_cost: 300, twitch_unsupported: false,
    }] as any);

    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.rewards).toHaveLength(1);
    expect(res.body.rewards[0].twitchReward).toBeNull();
    expect(res.body.rewards[0].rewardId).toBe('orphaned-rwd');
    expect(res.body.rewards[0].config.id).toBe(1);
    expect(res.body.rewards[0].previewPrice).not.toBeNull();
  });

  it('passes through twitch_unsupported so the view can show the disabled-by-Twitch message', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(getCustomRewards).mockResolvedValue([{ id: 'rwd1', title: 'Cool Reward', cost: 200, is_enabled: true } as any]);
    vi.mocked(getPricingConfigsForStreamer).mockResolvedValue([{
      id: 1, streamer_id: 123, twitch_reward_id: 'rwd1', enabled: false,
      base_cost: 200, cooldown_seconds: 300, max_multiplier: 4, curve: 1.5,
      demand: 0.2, demand_updated_at: '1700000000000', last_pushed_cost: null, twitch_unsupported: true,
    }] as any);

    const res = await supertest(buildApp()).get('/');
    expect(res.body.rewards[0].config.twitch_unsupported).toBe(true);
    expect(res.body.rewards[0].config.enabled).toBe(false);
  });

  it('leaves config/previewPrice null for a reward with no pricing config yet', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(getCustomRewards).mockResolvedValue([{ id: 'rwd1', title: 'Cool Reward', cost: 200, is_enabled: true } as any]);

    const res = await supertest(buildApp()).get('/');
    expect(res.body.rewards[0].config).toBeNull();
    expect(res.body.rewards[0].previewPrice).toBeNull();
  });

  it('does not include global settings for a non-owner', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp(USER)).get('/');
    expect(res.body.isOwner).toBe(false);
    expect(res.body.globalSettings).toBeNull();
    expect(getGlobalPricingSettings).not.toHaveBeenCalled();
  });

  it('includes global settings for the bot owner', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp(OWNER)).get('/');
    expect(res.body.isOwner).toBe(true);
    expect(res.body.globalSettings).toEqual({ decay_half_life_periods: 3, redemption_increment: 0.1 });
  });
});
