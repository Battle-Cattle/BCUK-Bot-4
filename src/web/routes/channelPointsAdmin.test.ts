import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  getPricingConfigsForStreamer: vi.fn(),
  getPricingSettingsForStreamer: vi.fn(),
  getPricingHistoryForRewards: vi.fn(),
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
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

vi.mock('../../twitch/eventsub/twitchEventSubSubscriptions', () => ({
  hasAuthFailedSubs: vi.fn(),
}));

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('./channelPointsAdminMutations', async () => {
  const { Router } = await import('express');
  return { router: Router() };
});

vi.mock('./channelPointsEvents', async () => {
  const { Router } = await import('express');
  return { default: Router() };
});

import supertest from 'supertest';
import router from './channelPointsAdmin';
import { getStreamerByDiscordId, getPricingConfigsForStreamer, getPricingSettingsForStreamer, getPricingHistoryForRewards } from '../../db';
import { getCustomRewards } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';
import { hasAuthFailedSubs } from '../../twitch/eventsub/twitchEventSubSubscriptions';
import { buildTestApp } from '../../test-utils/expressTestApp';
import { makeSessionUser, type SessionUserFixture } from '../../test-utils/fixtures';

type SessionUser = SessionUserFixture;
const USER: SessionUser = makeSessionUser({ isOwner: false });

const MOCK_STREAMER = {
  id: 123, twitch_user_id: 'twitch123', twitch_name: 'teststreamer', discord_id: USER.discordId,
  eventsub_access_token: 'encrypted-token',
};

/** Builds a supertest-ready app: the channel points admin router with a stubbed session and a render mock that flattens locals into the JSON body. */
function buildApp(sessionUser: SessionUser = USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser, mockRender: 'spread' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  vi.mocked(getPricingConfigsForStreamer).mockResolvedValue([]);
  vi.mocked(getCustomRewards).mockResolvedValue([]);
  vi.mocked(getValidToken).mockResolvedValue('token');
  vi.mocked(hasAuthFailedSubs).mockReturnValue(false);
  vi.mocked(getPricingSettingsForStreamer).mockResolvedValue({ half_life_seconds: 1800, time_to_max_multiplier: 2 });
  vi.mocked(getPricingHistoryForRewards).mockResolvedValue(new Map());
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

  it('rounds the preview price to round_to_nearest when configured on the pricing config', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(getCustomRewards).mockResolvedValue([{ id: 'rwd1', title: 'Cool Reward', cost: 200, is_enabled: true } as any]);
    vi.mocked(getPricingConfigsForStreamer).mockResolvedValue([{
      id: 1, streamer_id: 123, twitch_reward_id: 'rwd1', enabled: true,
      base_cost: 200, cooldown_seconds: 300, max_multiplier: 4, curve: 1.5, round_to_nearest: 10,
      demand: 0.5, demand_updated_at: '1700000000000', last_pushed_cost: 480, twitch_unsupported: false,
    }] as any);

    const res = await supertest(buildApp()).get('/');
    // raw price at demand=0.5 with these params is 482.84, rounded to nearest 10 -> 480.
    expect(res.body.rewards[0].previewPrice).toBe(480);
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

  it('includes the streamer\'s own pricing settings when connected', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp(USER)).get('/');
    expect(res.body.pricingSettings).toEqual({ half_life_seconds: 1800, time_to_max_multiplier: 2 });
    expect(getPricingSettingsForStreamer).toHaveBeenCalledWith(MOCK_STREAMER.id);
  });

  it('does not fetch pricing settings when not a streamer', async () => {
    const res = await supertest(buildApp(USER)).get('/');
    expect(res.body.pricingSettings).toBeNull();
    expect(getPricingSettingsForStreamer).not.toHaveBeenCalled();
  });

  describe('reconnect detection', () => {
    it('does not fetch rewards and reports isConnected=false when the streamer has no Twitch token', async () => {
      vi.mocked(getStreamerByDiscordId).mockResolvedValue({ ...MOCK_STREAMER, eventsub_access_token: null } as any);

      const res = await supertest(buildApp()).get('/');
      expect(res.body.isConnected).toBe(false);
      expect(res.body.needsReconnect).toBe(false);
      expect(res.body.rewards).toEqual([]);
      expect(getCustomRewards).not.toHaveBeenCalled();
    });

    it('does not fetch rewards and reports needsReconnect=true when subscriptions have failed with an auth error', async () => {
      vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
      vi.mocked(hasAuthFailedSubs).mockReturnValue(true);

      const res = await supertest(buildApp()).get('/');
      expect(res.body.isConnected).toBe(true);
      expect(res.body.needsReconnect).toBe(true);
      expect(res.body.rewards).toEqual([]);
      expect(getCustomRewards).not.toHaveBeenCalled();
    });

    it('fetches rewards normally when connected with no auth failures', async () => {
      vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
      vi.mocked(getCustomRewards).mockResolvedValue([{ id: 'rwd1', title: 'Cool Reward', cost: 200, is_enabled: true } as any]);

      const res = await supertest(buildApp()).get('/');
      expect(res.body.isConnected).toBe(true);
      expect(res.body.needsReconnect).toBe(false);
      expect(getCustomRewards).toHaveBeenCalled();
    });
  });

  it('exposes the selectable history hour options', async () => {
    const res = await supertest(buildApp()).get('/');
    expect(res.body.historyHourOptions).toEqual([1, 2, 3, 6, 9, 12, 24]);
  });

  describe('price history chart', () => {
    const CONFIG = {
      id: 1, streamer_id: 123, twitch_reward_id: 'rwd1', enabled: true,
      base_cost: 200, cooldown_seconds: 300, max_multiplier: 4, curve: 1.5,
      demand: 0.5, demand_updated_at: '1700000000000', last_pushed_cost: 300, twitch_unsupported: false,
    };

    beforeEach(() => {
      vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
      vi.mocked(getCustomRewards).mockResolvedValue([{ id: 'rwd1', title: 'Cool Reward', cost: 200, is_enabled: true } as any]);
      vi.mocked(getPricingConfigsForStreamer).mockResolvedValue([CONFIG] as any);
    });

    it('defaults to a 3-hour range when hours is not specified', async () => {
      const before = Date.now();
      const res = await supertest(buildApp()).get('/');
      const after = Date.now();

      expect(res.body.historyHours).toBe(3);
      expect(getPricingHistoryForRewards).toHaveBeenCalledWith([1], expect.any(Number));
      const sinceMs = vi.mocked(getPricingHistoryForRewards).mock.calls[0][1];
      expect(sinceMs).toBeGreaterThanOrEqual(before - 3 * 60 * 60 * 1000);
      expect(sinceMs).toBeLessThanOrEqual(after - 3 * 60 * 60 * 1000);
    });

    it('respects a valid hours query param', async () => {
      const res = await supertest(buildApp()).get('/?hours=6');
      expect(res.body.historyHours).toBe(6);
      const sinceMs = vi.mocked(getPricingHistoryForRewards).mock.calls[0][1];
      expect(Date.now() - sinceMs).toBeCloseTo(6 * 60 * 60 * 1000, -3);
    });

    it('falls back to the default for an invalid hours value', async () => {
      const res = await supertest(buildApp()).get('/?hours=999');
      expect(res.body.historyHours).toBe(3);
    });

    it('renders a chart string for a reward with a config (with points, and without), and null without a config', async () => {
      vi.mocked(getPricingHistoryForRewards).mockResolvedValue(new Map([[1, [{ recorded_at: '1700000000000', cost: 300, demand: 0.5 }]]]));
      const res = await supertest(buildApp()).get('/');
      expect(typeof res.body.rewards[0].historyChartSafeHtml).toBe('string');
      expect(res.body.rewards[0].historyChartSafeHtml).toContain('<svg');

      vi.mocked(getPricingConfigsForStreamer).mockResolvedValue([]);
      const res2 = await supertest(buildApp()).get('/');
      expect(res2.body.rewards[0].historyChartSafeHtml).toBeNull();
    });

    it('renders the empty-history placeholder when there are no points yet', async () => {
      const res = await supertest(buildApp()).get('/');
      expect(res.body.rewards[0].historyChartSafeHtml).toContain('No price history yet');
    });

    it('renders a chart for an unlinked (orphaned) reward too', async () => {
      vi.mocked(getCustomRewards).mockResolvedValue([]);
      vi.mocked(getPricingHistoryForRewards).mockResolvedValue(new Map([[1, [{ recorded_at: '1700000000000', cost: 300, demand: 0.5 }]]]));
      const res = await supertest(buildApp()).get('/');
      expect(res.body.rewards[0].twitchReward).toBeNull();
      expect(res.body.rewards[0].historyChartSafeHtml).toContain('<svg');
    });
  });

  describe('simulated ramp/cooldown chart', () => {
    const CONFIG = {
      id: 1, streamer_id: 123, twitch_reward_id: 'rwd1', enabled: true,
      base_cost: 200, cooldown_seconds: 300, max_multiplier: 4, curve: 1.5,
      demand: 0.5, demand_updated_at: '1700000000000', last_pushed_cost: 300, twitch_unsupported: false,
    };

    beforeEach(() => {
      vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
      vi.mocked(getCustomRewards).mockResolvedValue([{ id: 'rwd1', title: 'Cool Reward', cost: 200, is_enabled: true } as any]);
      vi.mocked(getPricingConfigsForStreamer).mockResolvedValue([CONFIG] as any);
    });

    it('renders a simulation chart and summary for a reward with a config', async () => {
      const res = await supertest(buildApp()).get('/');
      expect(res.body.rewards[0].simulationChartSafeHtml).toContain('<svg');
      expect(typeof res.body.rewards[0].simulationSummary).toBe('string');
      expect(res.body.rewards[0].simulationSummary).toMatch(/% demand/);
    });

    it('leaves simulationChartSafeHtml/simulationSummary null for a reward with no pricing config', async () => {
      vi.mocked(getPricingConfigsForStreamer).mockResolvedValue([]);
      const res = await supertest(buildApp()).get('/');
      expect(res.body.rewards[0].simulationChartSafeHtml).toBeNull();
      expect(res.body.rewards[0].simulationSummary).toBeNull();
    });

    it('renders a simulation chart for an unlinked (orphaned) reward too', async () => {
      vi.mocked(getCustomRewards).mockResolvedValue([]);
      const res = await supertest(buildApp()).get('/');
      expect(res.body.rewards[0].twitchReward).toBeNull();
      expect(res.body.rewards[0].simulationChartSafeHtml).toContain('<svg');
    });
  });
});
