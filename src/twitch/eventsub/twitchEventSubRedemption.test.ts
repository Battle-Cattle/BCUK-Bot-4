import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../db', () => ({
  getVideosForReward: vi.fn(), getStreamerById: vi.fn(), recordStreamerEvent: vi.fn(),
  getRedemptionProgress: vi.fn(), markRedemptionEffect: vi.fn(),
}));
vi.mock('../../audio/soundSelector', () => ({ pickWeightedRandom: vi.fn() }));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../pricing/rewardPricingService', () => ({ applyRedemptionPricing: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./twitchEventSubRedemptionAcks', () => ({
  prepareRedemptionConfirmation: vi.fn(), trackRedemptionAck: vi.fn(), pushRedemptionForConfirmation: vi.fn(),
}));

import { handleRedemption } from './twitchEventSubRedemption';
import { seenRedemptionIds, pendingRedemptionIds } from './twitchEventSubRedemptionDedup';
import {
  registerEventSubOverlayRuntime, registerEventSubCompanionRuntime, registerEventSubDashboardRuntime,
} from './twitchEventSubRuntime';
import {
  getVideosForReward, getStreamerById, recordStreamerEvent, getRedemptionProgress, markRedemptionEffect,
} from '../../db';
import { pickWeightedRandom } from '../../audio/soundSelector';
import { applyRedemptionPricing } from '../pricing/rewardPricingService';
import { prepareRedemptionConfirmation, trackRedemptionAck, pushRedemptionForConfirmation } from './twitchEventSubRedemptionAcks';

const mockPushOverlayEvent = vi.fn();
registerEventSubOverlayRuntime({ pushOverlayEvent: mockPushOverlayEvent });

const mockPushCompanionEvent = vi.fn();
registerEventSubCompanionRuntime({ pushCompanionEvent: mockPushCompanionEvent });

const mockPushDashboardEvent = vi.fn();
registerEventSubDashboardRuntime({ pushDashboardEvent: mockPushDashboardEvent });

// handleRedemption ignores its EventSubConfig argument (reserved for future use).
const CONFIG = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(recordStreamerEvent).mockResolvedValue(101);
  vi.mocked(getRedemptionProgress).mockReset().mockResolvedValue(null);
  vi.mocked(markRedemptionEffect).mockReset().mockResolvedValue(undefined);
  vi.mocked(prepareRedemptionConfirmation).mockReset().mockResolvedValue(false);
  vi.mocked(pushRedemptionForConfirmation).mockReset().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// handleRedemption
// ---------------------------------------------------------------------------
describe('handleRedemption', () => {
  const event = {
    id: 'redemption-1',
    user_login: 'redeemer',
    user_name: 'Redeemer',
    broadcaster_user_login: 'streamer',
    reward: { id: 'reward-abc', title: 'Cool Reward' },
    user_input: '',
  };
  const streamerId = 7;

  beforeEach(() => {
    vi.mocked(getStreamerById).mockResolvedValue({ discord_id: '999888777' } as any);
    seenRedemptionIds.clear();
    pendingRedemptionIds.clear();
  });

  it('does not call pushOverlayEvent when getVideosForReward returns an empty array', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);
    await handleRedemption('streamer', event, CONFIG, streamerId);
    expect(mockPushOverlayEvent).not.toHaveBeenCalled();
  });

  it('calls pickWeightedRandom and pushOverlayEvent with correct path when videos are available', async () => {
    const videos = [{ file: 'clip1.mp4', weight: 1 }, { file: 'clip2.mp4', weight: 2 }] as any[];
    vi.mocked(getVideosForReward).mockResolvedValue(videos);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip2.mp4');

    await handleRedemption('streamer', event, CONFIG, streamerId);

    expect(getVideosForReward).toHaveBeenCalledWith('reward-abc', streamerId);
    expect(pickWeightedRandom).toHaveBeenCalledWith(videos);
    expect(mockPushOverlayEvent).toHaveBeenCalledWith('streamer', '/overlay/videos/7/clip2.mp4');
  });

  it('pushes a companion event keyed by the streamer discord_id even when no videos are configured', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', event, CONFIG, streamerId);

    expect(getStreamerById).toHaveBeenCalledWith(streamerId);
    expect(mockPushCompanionEvent).toHaveBeenCalledWith('999888777', {
      type: 'channel_points_redemption',
      id: 'redemption-1',
      rewardId: 'reward-abc',
      rewardTitle: 'Cool Reward',
      userLogin: 'redeemer',
      userName: 'Redeemer',
      userInput: '',
      ackRequired: false,
      redeemedAt: expect.any(String),
    });
    expect(trackRedemptionAck).not.toHaveBeenCalled();
    expect(pushRedemptionForConfirmation).not.toHaveBeenCalled();
  });

  it('records a confirmation, arms its timer and pushes for confirmation when the reward requires it', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);
    vi.mocked(prepareRedemptionConfirmation).mockResolvedValue(true);

    await handleRedemption('streamer', event, CONFIG, streamerId);

    expect(prepareRedemptionConfirmation).toHaveBeenCalledWith(
      { id: 'redemption-1', rewardId: 'reward-abc', rewardTitle: 'Cool Reward', userLogin: 'redeemer' }, streamerId,
    );
    expect(trackRedemptionAck).toHaveBeenCalledWith('redemption-1', 'streamer');
    expect(pushRedemptionForConfirmation).toHaveBeenCalledWith('999888777', expect.objectContaining({ id: 'redemption-1', ackRequired: true }));
    expect(mockPushCompanionEvent).not.toHaveBeenCalled();
    // The confirmation record is a required effect, so it's written before the redemption is marked handled.
    expect(vi.mocked(prepareRedemptionConfirmation).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(markRedemptionEffect).mock.invocationCallOrder.at(-1)!);
  });

  it('still arms the confirmation timer when the streamer lookup fails, so the redemption is refunded', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);
    vi.mocked(prepareRedemptionConfirmation).mockResolvedValue(true);
    vi.mocked(getStreamerById).mockRejectedValueOnce(new Error('db down'));

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).resolves.toBe(true);

    expect(trackRedemptionAck).toHaveBeenCalledWith('redemption-1', 'streamer');
    expect(pushRedemptionForConfirmation).not.toHaveBeenCalled();
  });

  it('rejects without marking the redemption handled when recording the confirmation fails', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);
    vi.mocked(prepareRedemptionConfirmation).mockRejectedValueOnce(new Error('db down'));

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).rejects.toThrow('db down');

    expect(markRedemptionEffect).not.toHaveBeenCalledWith('redemption-1', streamerId, 'handled');
    expect(mockPushCompanionEvent).not.toHaveBeenCalled();
  });

  it('pushes a companion event in addition to triggering the overlay when videos are configured', async () => {
    const videos = [{ file: 'clip1.mp4', weight: 1 }] as any[];
    vi.mocked(getVideosForReward).mockResolvedValue(videos);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip1.mp4');

    await handleRedemption('streamer', event, CONFIG, streamerId);

    expect(mockPushCompanionEvent).toHaveBeenCalledWith('999888777', expect.objectContaining({ type: 'channel_points_redemption' }));
    expect(mockPushOverlayEvent).toHaveBeenCalledWith('streamer', '/overlay/videos/7/clip1.mp4');
  });

  it('does not push a companion event when the streamer cannot be found', async () => {
    vi.mocked(getStreamerById).mockResolvedValue(null);
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', event, CONFIG, streamerId);

    expect(mockPushCompanionEvent).not.toHaveBeenCalled();
  });

  it('still resolves successfully when the companion lookup throws, after the overlay has already triggered', async () => {
    vi.mocked(getStreamerById).mockRejectedValue(new Error('db unavailable'));
    const videos = [{ file: 'clip1.mp4', weight: 1 }] as any[];
    vi.mocked(getVideosForReward).mockResolvedValue(videos);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip1.mp4');

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).resolves.toBe(true);

    expect(mockPushCompanionEvent).not.toHaveBeenCalled();
    expect(mockPushOverlayEvent).toHaveBeenCalledWith('streamer', '/overlay/videos/7/clip1.mp4');
  });

  it('delivers the companion event only once when a getVideosForReward failure is retried, since the best-effort companion push runs after the overlay lookup', async () => {
    const videos = [{ file: 'clip1.mp4', weight: 1 }] as any[];
    vi.mocked(getVideosForReward).mockRejectedValueOnce(new Error('transient db error'));

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).rejects.toThrow('transient db error');
    expect(mockPushCompanionEvent).not.toHaveBeenCalled();

    vi.mocked(getVideosForReward).mockResolvedValue(videos);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip1.mp4');
    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).resolves.toBe(true);

    expect(mockPushCompanionEvent).toHaveBeenCalledOnce();
  });

  it('records each required effect in the durable ledger, then marks the redemption handled', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).resolves.toBe(true);

    expect(getRedemptionProgress).toHaveBeenCalledWith('redemption-1');
    expect(vi.mocked(markRedemptionEffect).mock.calls).toEqual([
      ['redemption-1', streamerId, 'dashboard_recorded'],
      ['redemption-1', streamerId, 'pricing_applied'],
      ['redemption-1', streamerId, 'handled'],
    ]);
    expect(seenRedemptionIds.has('redemption-1')).toBe(true);
  });

  it('drops a redemption the durable ledger already records as handled, after the in-memory cache forgot it', async () => {
    vi.mocked(getRedemptionProgress).mockResolvedValue({ dashboardRecorded: true, pricingApplied: true, handled: true });

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).resolves.toBe(false);

    expect(recordStreamerEvent).not.toHaveBeenCalled();
    expect(applyRedemptionPricing).not.toHaveBeenCalled();
    expect(getVideosForReward).not.toHaveBeenCalled();
    expect(mockPushCompanionEvent).not.toHaveBeenCalled();
    expect(markRedemptionEffect).not.toHaveBeenCalled();
    // Re-remembered in memory, and the in-flight claim released.
    expect(seenRedemptionIds.has('redemption-1')).toBe(true);
    expect(pendingRedemptionIds.has('redemption-1')).toBe(false);
  });

  it('resumes a partly-handled redemption without re-applying the effects the ledger records as done', async () => {
    vi.mocked(getRedemptionProgress).mockResolvedValue({ dashboardRecorded: true, pricingApplied: true, handled: false });
    vi.mocked(getVideosForReward).mockResolvedValue([{ file: 'clip1.mp4', weight: 1 }] as any[]);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip1.mp4');

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).resolves.toBe(true);

    expect(recordStreamerEvent).not.toHaveBeenCalled();
    expect(applyRedemptionPricing).not.toHaveBeenCalled();
    // Live effects still run: a late replay still plays the overlay and notifies the companion.
    expect(mockPushOverlayEvent).toHaveBeenCalledWith('streamer', '/overlay/videos/7/clip1.mp4');
    expect(mockPushCompanionEvent).toHaveBeenCalledOnce();
    expect(vi.mocked(markRedemptionEffect).mock.calls).toEqual([['redemption-1', streamerId, 'handled']]);
  });

  it('applies pricing on resume when only the dashboard record had completed', async () => {
    vi.mocked(getRedemptionProgress).mockResolvedValue({ dashboardRecorded: true, pricingApplied: false, handled: false });
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', event, CONFIG, streamerId);

    expect(recordStreamerEvent).not.toHaveBeenCalled();
    expect(applyRedemptionPricing).toHaveBeenCalledWith(streamerId, 'reward-abc', 'redemption-1');
  });

  it('keeps the pricing effect recorded but does not mark the redemption handled when a later step fails', async () => {
    vi.mocked(getVideosForReward).mockRejectedValueOnce(new Error('transient db error'));

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).rejects.toThrow('transient db error');

    expect(markRedemptionEffect).toHaveBeenCalledWith('redemption-1', streamerId, 'pricing_applied');
    expect(markRedemptionEffect).not.toHaveBeenCalledWith('redemption-1', streamerId, 'handled');
    expect(pendingRedemptionIds.has('redemption-1')).toBe(false);
    expect(seenRedemptionIds.has('redemption-1')).toBe(false);
  });

  it('sends no overlay or companion push when the final handled write fails, and sends each once on retry', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([{ file: 'clip1.mp4', weight: 1 }] as any[]);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip1.mp4');
    vi.mocked(markRedemptionEffect).mockImplementation(async (_id, _sid, effect) => {
      if (effect === 'handled') throw new Error('ledger write failed');
    });

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).rejects.toThrow('ledger write failed');
    expect(mockPushOverlayEvent).not.toHaveBeenCalled();
    expect(mockPushCompanionEvent).not.toHaveBeenCalled();

    // Retry: the ledger now records dashboard + pricing as done; the handled write succeeds.
    vi.mocked(getRedemptionProgress).mockResolvedValue({ dashboardRecorded: true, pricingApplied: true, handled: false });
    vi.mocked(markRedemptionEffect).mockResolvedValue(undefined);
    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).resolves.toBe(true);

    expect(mockPushOverlayEvent).toHaveBeenCalledOnce();
    expect(mockPushCompanionEvent).toHaveBeenCalledOnce();
  });

  it('propagates a ledger lookup failure and releases the in-flight claim without running any effect', async () => {
    vi.mocked(getRedemptionProgress).mockRejectedValueOnce(new Error('db down'));

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).rejects.toThrow('db down');

    expect(recordStreamerEvent).not.toHaveBeenCalled();
    expect(applyRedemptionPricing).not.toHaveBeenCalled();
    expect(pendingRedemptionIds.has('redemption-1')).toBe(false);
  });

  it('applies dynamic pricing for the redeemed reward', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', event, CONFIG, streamerId);

    expect(applyRedemptionPricing).toHaveBeenCalledWith(streamerId, 'reward-abc', 'redemption-1');
  });

  it('records a dashboard event using the reward title as detail when there is no user input', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', event, CONFIG, streamerId);

    expect(recordStreamerEvent).toHaveBeenCalledWith(streamerId, 'redemption', 'Redeemer', 'Cool Reward', 'redemption-1');
    expect(mockPushDashboardEvent).toHaveBeenCalledWith(streamerId, expect.objectContaining({
      eventType: 'redemption', displayName: 'Redeemer', detail: 'Cool Reward',
    }));
  });

  it('records a dashboard event including the viewer-entered text as detail when present', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', { ...event, user_input: 'drink water!' }, CONFIG, streamerId);

    expect(recordStreamerEvent).toHaveBeenCalledWith(streamerId, 'redemption', 'Redeemer', 'Cool Reward: drink water!', 'redemption-1');
  });

  it('passes the Twitch redemption id through to recordStreamerEvent as the idempotency key', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', { ...event, id: 'redemption-xyz' }, CONFIG, streamerId);

    expect(recordStreamerEvent).toHaveBeenCalledWith(streamerId, 'redemption', 'Redeemer', 'Cool Reward', 'redemption-xyz');
  });

  it('does not push a live dashboard event when recordStreamerEvent reports the redemption was already recorded (a retry after collision)', async () => {
    vi.mocked(recordStreamerEvent).mockResolvedValueOnce(null);
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', event, CONFIG, streamerId);

    expect(mockPushDashboardEvent).not.toHaveBeenCalled();
  });

  it('rejects and skips the overlay lookup when applyRedemptionPricing throws, since pricing is a required effect', async () => {
    vi.mocked(applyRedemptionPricing).mockRejectedValueOnce(new Error('pricing failed'));
    const videos = [{ file: 'clip1.mp4', weight: 1 }] as any[];
    vi.mocked(getVideosForReward).mockResolvedValue(videos);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip1.mp4');

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).rejects.toThrow('pricing failed');

    expect(getVideosForReward).not.toHaveBeenCalled();
    expect(mockPushOverlayEvent).not.toHaveBeenCalled();
    expect(mockPushCompanionEvent).not.toHaveBeenCalled();
  });

  it('delivers the companion event only once when a pricing failure is retried, since the best-effort companion push runs after the required effects', async () => {
    vi.mocked(applyRedemptionPricing).mockRejectedValueOnce(new Error('pricing failed'));
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).rejects.toThrow('pricing failed');
    expect(mockPushCompanionEvent).not.toHaveBeenCalled();

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).resolves.toBe(true);
    expect(mockPushCompanionEvent).toHaveBeenCalledOnce();
  });

  it('rejects and is not marked handled when recordStreamerEvent throws, since dashboard recording is a required effect', async () => {
    vi.mocked(recordStreamerEvent).mockRejectedValueOnce(new Error('db unavailable'));
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).rejects.toThrow('db unavailable');

    expect(applyRedemptionPricing).not.toHaveBeenCalled();
    expect(mockPushDashboardEvent).not.toHaveBeenCalled();

    // A retry with the same id must not be dropped as a duplicate.
    vi.mocked(recordStreamerEvent).mockResolvedValue(101);
    vi.mocked(getVideosForReward).mockResolvedValue([]);
    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).resolves.toBe(true);
  });

  it('ignores a second notification carrying the same redemption id', async () => {
    const videos = [{ file: 'clip1.mp4', weight: 1 }] as any[];
    vi.mocked(getVideosForReward).mockResolvedValue(videos);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip1.mp4');

    await handleRedemption('streamer', event, CONFIG, streamerId);
    await handleRedemption('streamer', event, CONFIG, streamerId);

    expect(recordStreamerEvent).toHaveBeenCalledOnce();
    expect(mockPushDashboardEvent).toHaveBeenCalledOnce();
    expect(mockPushCompanionEvent).toHaveBeenCalledOnce();
    expect(applyRedemptionPricing).toHaveBeenCalledOnce();
    expect(getVideosForReward).toHaveBeenCalledOnce();
    expect(mockPushOverlayEvent).toHaveBeenCalledOnce();
  });

  it('retries and completes on a second attempt with the same redemption id after the first attempt throws', async () => {
    const videos = [{ file: 'clip1.mp4', weight: 1 }] as any[];
    vi.mocked(getVideosForReward).mockRejectedValueOnce(new Error('transient db error'));

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).rejects.toThrow('transient db error');

    // The failed attempt must not be misclassified as "already handled" — none of its effects
    // should have been left counted from a partial run, and a retry must be free to run again.
    vi.mocked(getVideosForReward).mockResolvedValue(videos);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip1.mp4');

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).resolves.toBe(true);

    // The dashboard/pricing effects run ahead of the getVideosForReward call that failed the
    // first time, so they fire once per attempt (twice total). The companion push runs last —
    // after the overlay lookup — so it never reaches the failed first attempt and fires only
    // once, on the successful retry; the overlay trigger likewise only ever completes then.
    expect(recordStreamerEvent).toHaveBeenCalledTimes(2);
    expect(mockPushDashboardEvent).toHaveBeenCalledTimes(2);
    expect(mockPushCompanionEvent).toHaveBeenCalledOnce();
    expect(applyRedemptionPricing).toHaveBeenCalledTimes(2);
    expect(mockPushOverlayEvent).toHaveBeenCalledExactlyOnceWith('streamer', '/overlay/videos/7/clip1.mp4');
  });

  it('processes two notifications with different redemption ids normally', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', event, CONFIG, streamerId);
    await handleRedemption('streamer', { ...event, id: 'redemption-2' }, CONFIG, streamerId);

    expect(recordStreamerEvent).toHaveBeenCalledTimes(2);
  });

  it('resolves true when the redemption is actually processed, and false for a duplicate', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).resolves.toBe(true);
    await expect(handleRedemption('streamer', event, CONFIG, streamerId)).resolves.toBe(false);
  });
});

