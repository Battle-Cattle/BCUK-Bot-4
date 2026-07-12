import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../db', () => ({
  getPricingForReward: vi.fn(),
  recordPricingUpdate: vi.fn(),
  recordPricingHistory: vi.fn(),
  markPricingUnsupported: vi.fn(),
  deletePricingConfig: vi.fn(),
  getPricingSettingsForStreamer: vi.fn(),
  getStreamerById: vi.fn(),
}));

vi.mock('../eventsub/twitchApiEventSub', () => ({ getValidToken: vi.fn() }));
vi.mock('../twitchApi', () => {
  class TwitchRewardUnsupportedError extends Error {}
  class TwitchRewardAuthError extends Error {}
  return {
    updateRewardCost: vi.fn(), deleteCustomReward: vi.fn(), TwitchRewardUnsupportedError, TwitchRewardAuthError,
  };
});

import {
  getPricingForReward, recordPricingUpdate, recordPricingHistory, markPricingUnsupported, deletePricingConfig,
  getPricingSettingsForStreamer, getStreamerById,
} from '../../db';
import { getValidToken } from '../eventsub/twitchApiEventSub';
import { updateRewardCost, deleteCustomReward, TwitchRewardUnsupportedError, TwitchRewardAuthError } from '../twitchApi';
import {
  applyRedemptionPricing, applyDecayTick, resetAndDeletePricing, deleteRewardAndPricing,
  registerRewardPricingRuntime, __resetPushRateLimiterForTests,
} from './rewardPricingService';

const settings = { half_life_seconds: 1800, time_to_max_multiplier: 2 };
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
    round_to_nearest: 0,
    demand: 0,
    demand_updated_at: String(Date.now()),
    last_pushed_cost: null,
    twitch_unsupported: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPricingSettingsForStreamer).mockResolvedValue(settings);
  vi.mocked(getStreamerById).mockResolvedValue(streamer);
  vi.mocked(getValidToken).mockResolvedValue('user-token');
  vi.mocked(recordPricingHistory).mockResolvedValue(undefined);
  vi.mocked(deletePricingConfig).mockResolvedValue(undefined);
  // clearAllMocks() resets call history but not mockResolvedValue/mockRejectedValue
  // implementations, so reset this explicitly — otherwise a test that rejects
  // updateRewardCost without ...Once leaks that rejection into later tests.
  vi.mocked(updateRewardCost).mockResolvedValue(undefined);
  vi.mocked(deleteCustomReward).mockResolvedValue(undefined);
  // The push rate limiter's last-pushed-at cache is module-level state that would
  // otherwise leak between tests (e.g. a push in one test silently rate-limiting
  // the next test's push, since both use the same default reward key).
  __resetPushRateLimiterForTests();
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

  it('marks the reward unsupported and disables it on a 403, without recording demand or history', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 0, last_pushed_cost: null }));
    vi.mocked(updateRewardCost).mockRejectedValueOnce(new TwitchRewardUnsupportedError('403'));
    await applyRedemptionPricing(1, 'rwd1');
    expect(markPricingUnsupported).toHaveBeenCalledWith(1, 'rwd1');
    expect(recordPricingUpdate).not.toHaveBeenCalled();
    expect(recordPricingHistory).not.toHaveBeenCalled();
  });

  it('records a price history point using the row id, computed cost, and demand', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ id: 42, demand: 0, last_pushed_cost: null }));
    await applyRedemptionPricing(1, 'rwd1');
    expect(recordPricingHistory).toHaveBeenCalledWith(42, expect.any(Number), expect.any(Number), expect.any(Number));
  });

  it('does not fail the sync when recording history throws', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 0, last_pushed_cost: null }));
    vi.mocked(recordPricingHistory).mockRejectedValueOnce(new Error('history db down'));
    await expect(applyRedemptionPricing(1, 'rwd1')).resolves.toBeUndefined();
    expect(recordPricingUpdate).toHaveBeenCalled();
  });

  it('on a 401, does not mark the reward unsupported but still persists the recalculated demand', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 0, last_pushed_cost: null }));
    vi.mocked(updateRewardCost).mockRejectedValueOnce(new TwitchRewardAuthError('401'));
    await applyRedemptionPricing(1, 'rwd1');
    expect(markPricingUnsupported).not.toHaveBeenCalled();
    expect(recordPricingUpdate).toHaveBeenCalledWith(1, 'rwd1', expect.any(Number), expect.any(Number), null);
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
    vi.mocked(updateRewardCost).mockRejectedValueOnce(new Error('Twitch down'));
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
      demand_updated_at: String(Date.now() - 300_000), // 300s elapsed
      last_pushed_cost: null,
    }));
    await applyDecayTick(1, 'rwd1');
    const [, , demandArg] = vi.mocked(recordPricingUpdate).mock.calls[0];
    // decay(0.5, ~300s elapsed, half_life=1800s) = 0.5 * 2^(-300/1800)
    expect(demandArg).toBeCloseTo(0.5 * Math.pow(2, -300 / 1800), 2);
  });

  it('fetches settings itself when no settingsHint is passed', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 0.5, last_pushed_cost: null }));
    await applyDecayTick(1, 'rwd1');
    expect(getPricingSettingsForStreamer).toHaveBeenCalledWith(1);
  });

  it('uses the provided settingsHint instead of fetching settings', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({
      demand: 0.5,
      demand_updated_at: String(Date.now() - 300_000),
      last_pushed_cost: null,
    }));
    const hintSettings = { half_life_seconds: 60, time_to_max_multiplier: 2 };

    await applyDecayTick(1, 'rwd1', hintSettings);

    expect(getPricingSettingsForStreamer).not.toHaveBeenCalled();
    const [, , demandArg] = vi.mocked(recordPricingUpdate).mock.calls[0];
    // decay(0.5, ~300s elapsed, half_life=60s from the hint, not the default 1800s) ≈ 0
    expect(demandArg).toBeCloseTo(0.5 * Math.pow(2, -300 / 60), 4);
  });
});

describe('round_to_nearest', () => {
  it('pushes the price rounded to the configured step, not the raw computed price', async () => {
    // decay-only tick (no redemption increment) with elapsed~0 keeps demand pinned at exactly 0.5.
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({
      demand: 0.5, demand_updated_at: String(Date.now()), last_pushed_cost: null, round_to_nearest: 10,
    }));
    await applyDecayTick(1, 'rwd1');
    // raw price at demand=0.5 (base_cost=200, max_multiplier=4, curve=1.5) is 482.84,
    // which rounds to 480 at round_to_nearest=10 (see rewardPricingMath.test.ts).
    expect(updateRewardCost).toHaveBeenCalledWith('bc1', 'rwd1', 480, 'user-token');
    expect(recordPricingUpdate).toHaveBeenCalledWith(1, 'rwd1', expect.any(Number), expect.any(Number), 480);
  });

  it('skips the Twitch push (but still persists demand) when the rounded price matches last_pushed_cost, even though the underlying demand has changed', async () => {
    // demand=0.5 (raw 482.84) and demand=0.55 (raw 526.32) both round to 500 at
    // round_to_nearest=100 — the update should only fire once the *rounded* price moves.
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({
      demand: 0.55, demand_updated_at: String(Date.now()), last_pushed_cost: 500, round_to_nearest: 100,
    }));
    await applyDecayTick(1, 'rwd1');
    expect(updateRewardCost).not.toHaveBeenCalled();
    expect(recordPricingUpdate).toHaveBeenCalledWith(1, 'rwd1', expect.any(Number), expect.any(Number), 500);
  });
});

describe('resetAndDeletePricing', () => {
  it('resets the Twitch cost to base_cost, then deletes the config', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ id: 42, base_cost: 200 }));
    await resetAndDeletePricing(1, 'rwd1');
    expect(updateRewardCost).toHaveBeenCalledWith('bc1', 'rwd1', 200, 'user-token');
    expect(deletePricingConfig).toHaveBeenCalledWith(42, 1);
    const [resetOrder] = vi.mocked(updateRewardCost).mock.invocationCallOrder;
    const [deleteOrder] = vi.mocked(deletePricingConfig).mock.invocationCallOrder;
    expect(resetOrder).toBeLessThan(deleteOrder);
  });

  it('skips the reset (but still deletes) when the reward is marked unsupported', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ id: 42, twitch_unsupported: true }));
    await resetAndDeletePricing(1, 'rwd1');
    expect(updateRewardCost).not.toHaveBeenCalled();
    expect(deletePricingConfig).toHaveBeenCalledWith(42, 1);
  });

  it('no-ops entirely when no pricing config exists for the reward', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(null);
    await resetAndDeletePricing(1, 'rwd1');
    expect(updateRewardCost).not.toHaveBeenCalled();
    expect(deletePricingConfig).not.toHaveBeenCalled();
  });

  it('still deletes when the Twitch reset fails', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ id: 42 }));
    vi.mocked(updateRewardCost).mockRejectedValueOnce(new Error('twitch down'));
    await expect(resetAndDeletePricing(1, 'rwd1')).resolves.toBeUndefined();
    expect(deletePricingConfig).toHaveBeenCalledWith(42, 1);
  });

  it('serializes with a concurrent applyDecayTick on the same reward key', async () => {
    const order: string[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });

    vi.mocked(getPricingForReward).mockImplementation(async () => {
      order.push('read');
      if (order.filter((o) => o === 'read').length === 1) {
        await firstGate; // the decay tick's read blocks here until released
      }
      return makeRow();
    });
    vi.mocked(deletePricingConfig).mockImplementation(async () => {
      order.push('delete');
    });
    vi.mocked(recordPricingUpdate).mockImplementation(async () => {
      order.push('write');
    });

    const decayTick = applyDecayTick(1, 'rwd1');
    const del = resetAndDeletePricing(1, 'rwd1'); // same key — must wait for the decay tick to finish

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['read']); // the delete's read hasn't happened yet — it's queued behind the decay tick

    resolveFirst();
    await Promise.all([decayTick, del]);
    expect(order).toEqual(['read', 'write', 'read', 'delete']);
  });
});

describe('deleteRewardAndPricing', () => {
  it('deletes the reward on Twitch, then deletes the local pricing config', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ id: 42 }));
    await deleteRewardAndPricing(1, 'rwd1');
    expect(deleteCustomReward).toHaveBeenCalledWith('bc1', 'rwd1', 'user-token');
    expect(deletePricingConfig).toHaveBeenCalledWith(42, 1);
    const [deleteRewardOrder] = vi.mocked(deleteCustomReward).mock.invocationCallOrder;
    const [deleteConfigOrder] = vi.mocked(deletePricingConfig).mock.invocationCallOrder;
    expect(deleteRewardOrder).toBeLessThan(deleteConfigOrder);
  });

  it('deletes the reward on Twitch without touching the local config when none exists', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(null);
    await deleteRewardAndPricing(1, 'rwd1');
    expect(deleteCustomReward).toHaveBeenCalledWith('bc1', 'rwd1', 'user-token');
    expect(deletePricingConfig).not.toHaveBeenCalled();
  });

  it('throws (and does not delete the local config) when no valid token is available', async () => {
    vi.mocked(getValidToken).mockResolvedValue(null);
    await expect(deleteRewardAndPricing(1, 'rwd1')).rejects.toThrow();
    expect(deleteCustomReward).not.toHaveBeenCalled();
    expect(deletePricingConfig).not.toHaveBeenCalled();
  });

  it('propagates a 403 from Twitch (reward not created by this app) without deleting the local config', async () => {
    vi.mocked(deleteCustomReward).mockRejectedValueOnce(new TwitchRewardUnsupportedError('403'));
    await expect(deleteRewardAndPricing(1, 'rwd1')).rejects.toBeInstanceOf(TwitchRewardUnsupportedError);
    expect(deletePricingConfig).not.toHaveBeenCalled();
  });

  it('serializes with a concurrent applyRedemptionPricing on the same reward key', async () => {
    const order: string[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });

    vi.mocked(getPricingForReward).mockImplementation(async () => {
      order.push('read');
      if (order.filter((o) => o === 'read').length === 1) {
        await firstGate; // the redemption's read blocks here until released
      }
      return makeRow({ id: 42, demand: 0, last_pushed_cost: null });
    });
    vi.mocked(recordPricingUpdate).mockImplementation(async () => {
      order.push('write');
    });
    vi.mocked(deletePricingConfig).mockImplementation(async () => {
      order.push('delete');
    });

    const redemption = applyRedemptionPricing(1, 'rwd1');
    const del = deleteRewardAndPricing(1, 'rwd1'); // same key — must wait for the redemption to finish

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['read']); // the delete's read hasn't happened yet — it's queued behind the redemption

    resolveFirst();
    await Promise.all([redemption, del]);
    expect(order).toEqual(['read', 'write', 'read', 'delete']);
  });
});

describe('redemption push rate limiting', () => {
  it('does not push to Twitch again for the same reward within the rate-limit window, but still persists demand both times', async () => {
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 0, last_pushed_cost: null }));

    await applyRedemptionPricing(1, 'rwd1');
    await applyRedemptionPricing(1, 'rwd1'); // same reward, moments later — within the 5s window

    expect(updateRewardCost).toHaveBeenCalledTimes(1);
    expect(recordPricingUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not rate-limit a different reward for the same streamer', async () => {
    vi.mocked(getPricingForReward).mockImplementation(async (_streamerId, twitchRewardId) =>
      makeRow({ twitch_reward_id: twitchRewardId, demand: 0, last_pushed_cost: null }));

    await applyRedemptionPricing(1, 'rwd1');
    await applyRedemptionPricing(1, 'rwd2');

    expect(updateRewardCost).toHaveBeenCalledTimes(2);
  });

  it('pushes again once the rate-limit window has elapsed', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 0, last_pushed_cost: null }));

      await applyRedemptionPricing(1, 'rwd1');
      expect(updateRewardCost).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      await applyRedemptionPricing(1, 'rwd1');
      expect(updateRewardCost).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('live pricing update push', () => {
  it('pushes the computed cost and demand to the registered runtime after a successful sync', async () => {
    const pushPricingUpdate = vi.fn();
    registerRewardPricingRuntime({ pushPricingUpdate });
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 0, last_pushed_cost: null }));

    await applyRedemptionPricing(1, 'rwd1');

    expect(pushPricingUpdate).toHaveBeenCalledWith(1, {
      rewardId: 'rwd1', cost: expect.any(Number), demand: expect.any(Number), recordedAt: expect.any(Number),
    });
  });

  it('still pushes the live update when recording price history fails', async () => {
    const pushPricingUpdate = vi.fn();
    registerRewardPricingRuntime({ pushPricingUpdate });
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 0, last_pushed_cost: null }));
    vi.mocked(recordPricingHistory).mockRejectedValueOnce(new Error('history db down'));

    await applyRedemptionPricing(1, 'rwd1');

    expect(pushPricingUpdate).toHaveBeenCalled();
  });

  it('does not push when the reward has no pricing config', async () => {
    const pushPricingUpdate = vi.fn();
    registerRewardPricingRuntime({ pushPricingUpdate });
    vi.mocked(getPricingForReward).mockResolvedValue(null);

    await applyRedemptionPricing(1, 'rwd1');

    expect(pushPricingUpdate).not.toHaveBeenCalled();
  });

  it('does not fail the sync when the runtime push throws', async () => {
    registerRewardPricingRuntime({
      pushPricingUpdate: () => { throw new Error('push failed'); },
    });
    vi.mocked(getPricingForReward).mockResolvedValue(makeRow({ demand: 0, last_pushed_cost: null }));

    await expect(applyRedemptionPricing(1, 'rwd1')).resolves.toBeUndefined();
    expect(recordPricingUpdate).toHaveBeenCalled();
  });
});
