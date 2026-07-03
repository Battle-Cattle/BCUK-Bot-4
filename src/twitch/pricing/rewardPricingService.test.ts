import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

vi.mock('../../db', () => ({
  getPricingForReward: vi.fn(),
  recordPricingUpdate: vi.fn(),
  markPricingUnsupported: vi.fn(),
  getGlobalPricingSettings: vi.fn(),
  getStreamerById: vi.fn(),
}));

vi.mock('../eventsub/twitchApiEventSub', () => ({ getValidToken: vi.fn() }));
vi.mock('../twitchApi', () => {
  class TwitchRewardUnsupportedError extends Error {}
  return { updateRewardCost: vi.fn(), TwitchRewardUnsupportedError };
});

import {
  getPricingForReward, recordPricingUpdate, markPricingUnsupported, getGlobalPricingSettings, getStreamerById,
} from '../../db';
import { getValidToken } from '../eventsub/twitchApiEventSub';
import { updateRewardCost, TwitchRewardUnsupportedError } from '../twitchApi';
import { applyRedemptionPricing, applyDecayTick } from './rewardPricingService';

const settings = { decay_half_life_periods: 3, redemption_increment: 0.1 };
const streamer = { id: 1, twitch_user_id: 'bc1', eventsub_access_token: 'tok' } as any;

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    streamer_id: 1,
    twitch_reward_id: 'rwd1',
    enabled: true,
    base_cost: 200,
    cooldown_seconds: 300,
    max_multiplier: 4,
    curve: 1.5,
    demand: 0,
    demand_updated_at: String(Date.now()),
    last_pushed_cost: null,
    twitch_unsupported: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getGlobalPricingSettings).mockResolvedValue(settings);
  vi.mocked(getStreamerById).mockResolvedValue(streamer);
  vi.mocked(getValidToken).mockResolvedValue('user-token');
});

describe('applyRedemptionPricing', () => {
  it('no-ops (no DB write, no Twitch call) when no pricing config exists', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(null);
    await applyRedemptionPricing(1, 'rwd1');
    expect(updateRewardCost).not.toHaveBeenCalled();
    expect(recordPricingUpdate).not.toHaveBeenCalled();
  });

  it('no-ops when pricing is disabled for the reward', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ enabled: false }));
    await applyRedemptionPricing(1, 'rwd1');
    expect(updateRewardCost).not.toHaveBeenCalled();
    expect(recordPricingUpdate).not.toHaveBeenCalled();
  });

  it('pushes the new cost to Twitch when it differs from last_pushed_cost', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 0, last_pushed_cost: null }));
    await applyRedemptionPricing(1, 'rwd1');
    expect(updateRewardCost).toHaveBeenCalledWith('bc1', 'rwd1', expect.any(Number), 'user-token');
    expect(recordPricingUpdate).toHaveBeenCalledWith(1, 'rwd1', expect.any(Number), expect.any(Number), expect.any(Number));
  });

  it('marks the reward unsupported and disables it on a 403, without recording demand', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 0, last_pushed_cost: null }));
    vi.mocked(updateRewardCost).mockRejectedValue(new TwitchRewardUnsupportedError('403'));
    await applyRedemptionPricing(1, 'rwd1');
    expect(markPricingUnsupported).toHaveBeenCalledWith(1, 'rwd1');
    expect(recordPricingUpdate).not.toHaveBeenCalled();
  });

  it('skips the Twitch call when the recomputed price equals last_pushed_cost', async () => {
    // demand pinned at 1 (max), last_pushed_cost already at the max price -> redemption increment
    // still saturates at demand=1, so price stays the same as last_pushed_cost.
    const maxPrice = Math.round(200 * (1 + Math.pow(1, 1.5) * 4)); // 1000
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 1, demand_updated_at: String(Date.now()), last_pushed_cost: maxPrice }));
    await applyRedemptionPricing(1, 'rwd1');
    expect(updateRewardCost).not.toHaveBeenCalled();
    expect(recordPricingUpdate).toHaveBeenCalledWith(1, 'rwd1', expect.any(Number), expect.any(Number), maxPrice);
  });

  it('swallows a Twitch push failure but still persists the recalculated demand', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 0, last_pushed_cost: null }));
    vi.mocked(updateRewardCost).mockRejectedValue(new Error('Twitch down'));
    await expect(applyRedemptionPricing(1, 'rwd1')).resolves.toBeUndefined();
    expect(recordPricingUpdate).toHaveBeenCalledWith(1, 'rwd1', expect.any(Number), expect.any(Number), null);
  });

  it('skips the push (but still persists demand) when no valid token is available', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 0, last_pushed_cost: null }));
    vi.mocked(getValidToken).mockResolvedValue(null);
    await applyRedemptionPricing(1, 'rwd1');
    expect(updateRewardCost).not.toHaveBeenCalled();
    expect(recordPricingUpdate).toHaveBeenCalledWith(1, 'rwd1', expect.any(Number), expect.any(Number), null);
  });

  it('serializes two concurrent calls on the same reward key', async () => {
    const order: string[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });

    vi.mocked(getPricingForReward).mockImplementation(async () => {
      order.push('read');
      if (order.filter((o) => o === 'read').length === 1) {
        await firstGate; // first call blocks here until released
      }
      return makeRow({ demand: 0, last_pushed_cost: null });
    });
    vi.mocked(recordPricingUpdate).mockImplementation(async () => {
      order.push('write');
    });

    const first = applyRedemptionPricing(1, 'rwd1');
    const second = applyRedemptionPricing(1, 'rwd1'); // same key — must wait for first to finish

    // Give the second call a chance to run if it were (incorrectly) not serialized.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['read']); // second call's read hasn't happened yet — it's queued behind the first

    resolveFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['read', 'write', 'read', 'write']);
  });

  it('does not serialize calls on different reward keys', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 0, last_pushed_cost: null }));
    await Promise.all([
      applyRedemptionPricing(1, 'rwd1'),
      applyRedemptionPricing(1, 'rwd2'),
    ]);
    expect(recordPricingUpdate).toHaveBeenCalledTimes(2);
  });
});

describe('applyDecayTick', () => {
  it('applies decay without the redemption increment', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({
      demand: 0.5,
      demand_updated_at: String(Date.now() - 300_000), // 300s elapsed, cooldown=300s -> 1 period of decay
      last_pushed_cost: null,
    }));
    await applyDecayTick(1, 'rwd1');
    const [, , demandArg] = vi.mocked(recordPricingUpdate).mock.calls[0];
    // decay(0.5, 300, 300, 3) = 0.5 * 2^(-1/3) ≈ 0.39700
    expect(demandArg).toBeCloseTo(0.397, 2);
  });
});
