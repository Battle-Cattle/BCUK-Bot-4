import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../db', () => ({
  claimRedemptionAck: vi.fn(),
  releaseRedemptionAck: vi.fn(),
  updateRedemptionAckStatus: vi.fn(),
  listPendingRedemptionAcks: vi.fn(),
  isCompanionConfirmationRequired: vi.fn(),
  recordPendingRedemptionAck: vi.fn(),
  getStreamerById: vi.fn(),
}));
vi.mock('../twitchUserTokens', () => ({ getValidToken: vi.fn() }));
vi.mock('../twitchApi', () => {
  class TwitchRedemptionNotFoundError extends Error {}
  class TwitchRewardUnsupportedError extends Error {}
  class TwitchRewardAuthError extends Error {}
  return { updateRedemptionStatus: vi.fn(), TwitchRedemptionNotFoundError, TwitchRewardUnsupportedError, TwitchRewardAuthError };
});
vi.mock('../pricing/rewardPricingService', () => ({ revertRedemptionPricing: vi.fn() }));

import {
  claimRedemptionAck, releaseRedemptionAck, updateRedemptionAckStatus, listPendingRedemptionAcks,
  isCompanionConfirmationRequired, recordPendingRedemptionAck, getStreamerById,
} from '../../db';
import { getValidToken } from '../twitchUserTokens';
import { updateRedemptionStatus, TwitchRedemptionNotFoundError } from '../twitchApi';
import { revertRedemptionPricing } from '../pricing/rewardPricingService';
import { registerEventSubCompanionRuntime, registerEventSubTwitchRuntime } from './twitchEventSubRuntime';
import {
  REDEMPTION_ACK_TIMEOUT_MS, prepareRedemptionConfirmation, refundRedemption, trackRedemptionAck,
  pushRedemptionForConfirmation, acknowledgeRedemption, sweepPendingRedemptionAcks, clearRedemptionAcks,
} from './twitchEventSubRedemptionAcks';
import { flushMicrotasks } from '../../test-utils/flushMicrotasks';

const send = vi.fn();
const pushCompanionEvent = vi.fn();
const hasCompanionConnection = vi.fn();
const CLAIMED = {
  redemptionId: 'red1', streamerId: 3, twitchRewardId: 'rwd1', rewardTitle: 'Lights', userLogin: 'alice', redeemedAtMs: 1_000,
};
const EVENT = {
  type: 'channel_points_redemption' as const, id: 'red1', rewardId: 'rwd1', rewardTitle: 'Lights',
  userLogin: 'alice', userName: 'Alice', userInput: '', ackRequired: true, redeemedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue(undefined);
  hasCompanionConnection.mockReturnValue(true);
  registerEventSubTwitchRuntime({ send });
  registerEventSubCompanionRuntime({ pushCompanionEvent, hasCompanionConnection });
  vi.mocked(claimRedemptionAck).mockResolvedValue(CLAIMED);
  vi.mocked(getStreamerById).mockResolvedValue({ id: 3, twitch_user_id: 'bc1' } as any);
  vi.mocked(getValidToken).mockResolvedValue('user-token');
  vi.mocked(updateRedemptionStatus).mockResolvedValue(undefined);
  vi.mocked(revertRedemptionPricing).mockResolvedValue(undefined);
});

afterEach(() => {
  clearRedemptionAcks();
  vi.useRealTimers();
});

describe('prepareRedemptionConfirmation', () => {
  const redemption = { id: 'red1', rewardId: 'rwd1', rewardTitle: 'Lights', userLogin: 'alice' };

  it('records nothing when the reward does not require confirmation', async () => {
    vi.mocked(isCompanionConfirmationRequired).mockResolvedValueOnce(false);
    expect(await prepareRedemptionConfirmation(redemption, 3)).toBe(false);
    expect(recordPendingRedemptionAck).not.toHaveBeenCalled();
  });

  it('records the redemption as pending when the reward requires confirmation', async () => {
    vi.mocked(isCompanionConfirmationRequired).mockResolvedValueOnce(true);
    expect(await prepareRedemptionConfirmation(redemption, 3)).toBe(true);
    expect(isCompanionConfirmationRequired).toHaveBeenCalledWith(3, 'rwd1');
    expect(recordPendingRedemptionAck).toHaveBeenCalledWith({
      redemptionId: 'red1', streamerId: 3, twitchRewardId: 'rwd1', rewardTitle: 'Lights', userLogin: 'alice', redeemedAtMs: expect.any(Number),
    });
  });
});

describe('refundRedemption', () => {
  it('cancels the redemption on Twitch, reverts its pricing and tells the viewer', async () => {
    expect(await refundRedemption('red1', 'no_ack', { channel: 'streamer' })).toBe(true);

    expect(claimRedemptionAck).toHaveBeenCalledWith('red1', { status: 'refunded', refundReason: 'no_ack', errorMessage: undefined });
    expect(updateRedemptionStatus).toHaveBeenCalledWith('bc1', 'rwd1', 'red1', 'CANCELED', 'user-token');
    expect(revertRedemptionPricing).toHaveBeenCalledWith(3, 'rwd1', 1_000);
    expect(send).toHaveBeenCalledWith('streamer', expect.stringContaining('@alice your "Lights" redemption was refunded'));
  });

  it('does nothing when the redemption was already resolved', async () => {
    vi.mocked(claimRedemptionAck).mockResolvedValueOnce(null);
    expect(await refundRedemption('red1', 'no_ack', { channel: 'streamer' })).toBe(false);
    expect(updateRedemptionStatus).not.toHaveBeenCalled();
    expect(revertRedemptionPricing).not.toHaveBeenCalled();
  });

  it('records refund_failed (still reverting pricing, but sending no notice) when Twitch refuses for good', async () => {
    vi.mocked(updateRedemptionStatus).mockRejectedValueOnce(new TwitchRedemptionNotFoundError('not unfulfilled'));
    expect(await refundRedemption('red1', 'companion_error', { channel: 'streamer' })).toBe(true);

    expect(updateRedemptionAckStatus).toHaveBeenCalledWith('red1', 'refund_failed', 'not unfulfilled');
    expect(revertRedemptionPricing).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('records refund_failed when the streamer has no usable token', async () => {
    vi.mocked(getValidToken).mockResolvedValueOnce(null);
    expect(await refundRedemption('red1', 'restart')).toBe(true);
    expect(updateRedemptionStatus).not.toHaveBeenCalled();
    expect(updateRedemptionAckStatus).toHaveBeenCalledWith('red1', 'refund_failed', 'No valid broadcaster token');
  });

  it('releases the claim and rethrows on a transient Twitch failure, without reverting pricing', async () => {
    vi.mocked(updateRedemptionStatus).mockRejectedValueOnce(new Error('503'));
    await expect(refundRedemption('red1', 'no_ack')).rejects.toThrow('503');
    expect(releaseRedemptionAck).toHaveBeenCalledWith('red1');
    expect(revertRedemptionPricing).not.toHaveBeenCalled();
  });

  it('survives a failed pricing revert and a failed chat notice', async () => {
    vi.mocked(revertRedemptionPricing).mockRejectedValueOnce(new Error('db down'));
    send.mockRejectedValueOnce(new Error('offline'));
    await expect(refundRedemption('red1', 'no_ack', { channel: 'streamer' })).resolves.toBe(true);
  });
});

describe('trackRedemptionAck', () => {
  it('refunds once the timeout passes without an acknowledgement', async () => {
    vi.useFakeTimers();
    trackRedemptionAck('red1', 'streamer');

    await vi.advanceTimersByTimeAsync(REDEMPTION_ACK_TIMEOUT_MS - 1);
    expect(claimRedemptionAck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(claimRedemptionAck).toHaveBeenCalledWith('red1', expect.objectContaining({ refundReason: 'no_ack' }));
  });

  it('retries a refund that failed after another timeout', async () => {
    vi.useFakeTimers();
    vi.mocked(claimRedemptionAck).mockRejectedValueOnce(new Error('db down'));
    trackRedemptionAck('red1', 'streamer');

    await vi.advanceTimersByTimeAsync(REDEMPTION_ACK_TIMEOUT_MS);
    await flushMicrotasks();
    expect(claimRedemptionAck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REDEMPTION_ACK_TIMEOUT_MS);
    expect(claimRedemptionAck).toHaveBeenCalledTimes(2);
    expect(updateRedemptionStatus).toHaveBeenCalledWith('bc1', 'rwd1', 'red1', 'CANCELED', 'user-token');
  });
});

describe('pushRedemptionForConfirmation', () => {
  it('pushes the event when a companion app is connected', async () => {
    await pushRedemptionForConfirmation('d1', EVENT);
    expect(hasCompanionConnection).toHaveBeenCalledWith('d1');
    expect(pushCompanionEvent).toHaveBeenCalledWith('d1', EVENT);
    expect(claimRedemptionAck).not.toHaveBeenCalled();
  });

  it('refunds straight away (cancelling the timer) when no companion app is connected', async () => {
    vi.useFakeTimers();
    hasCompanionConnection.mockReturnValue(false);
    trackRedemptionAck('red1', 'streamer');

    await pushRedemptionForConfirmation('d1', EVENT);

    expect(pushCompanionEvent).not.toHaveBeenCalled();
    expect(claimRedemptionAck).toHaveBeenCalledWith('red1', expect.objectContaining({ refundReason: 'no_companion' }));
    expect(send).toHaveBeenCalledWith('streamer', expect.stringContaining("companion app isn't connected"));
    await vi.advanceTimersByTimeAsync(REDEMPTION_ACK_TIMEOUT_MS);
    expect(claimRedemptionAck).toHaveBeenCalledTimes(1);
  });
});

describe('acknowledgeRedemption', () => {
  it('fulfils the redemption on success and cancels the timeout', async () => {
    vi.useFakeTimers();
    trackRedemptionAck('red1', 'streamer');

    expect(await acknowledgeRedemption('red1', { ok: true })).toBe(true);
    expect(claimRedemptionAck).toHaveBeenCalledWith('red1', { status: 'fulfilled' });
    expect(updateRedemptionStatus).toHaveBeenCalledWith('bc1', 'rwd1', 'red1', 'FULFILLED', 'user-token');
    expect(revertRedemptionPricing).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(REDEMPTION_ACK_TIMEOUT_MS);
    expect(claimRedemptionAck).toHaveBeenCalledTimes(1);
  });

  it('still reports success when marking it fulfilled on Twitch fails', async () => {
    vi.mocked(updateRedemptionStatus).mockRejectedValueOnce(new Error('503'));
    expect(await acknowledgeRedemption('red1', { ok: true })).toBe(true);
    vi.mocked(updateRedemptionStatus).mockRejectedValueOnce(new TwitchRedemptionNotFoundError('gone'));
    expect(await acknowledgeRedemption('red1', { ok: true })).toBe(true);
  });

  it('refunds with the companion error on failure, noticing in the tracked channel', async () => {
    trackRedemptionAck('red1', 'streamer');
    expect(await acknowledgeRedemption('red1', { ok: false, error: 'bulb offline' })).toBe(true);
    expect(claimRedemptionAck).toHaveBeenCalledWith('red1', { status: 'refunded', refundReason: 'companion_error', errorMessage: 'bulb offline' });
    expect(send).toHaveBeenCalledWith('streamer', expect.stringContaining("couldn't run it"));
  });

  it('returns false for a late or duplicate acknowledgement', async () => {
    vi.mocked(claimRedemptionAck).mockResolvedValueOnce(null);
    expect(await acknowledgeRedemption('red1', { ok: true })).toBe(false);
  });

  it('re-arms the timeout when applying the acknowledgement throws', async () => {
    vi.useFakeTimers();
    trackRedemptionAck('red1', 'streamer');
    vi.mocked(claimRedemptionAck).mockRejectedValueOnce(new Error('db down'));

    await expect(acknowledgeRedemption('red1', { ok: true })).rejects.toThrow('db down');
    await vi.advanceTimersByTimeAsync(REDEMPTION_ACK_TIMEOUT_MS);
    expect(claimRedemptionAck).toHaveBeenLastCalledWith('red1', expect.objectContaining({ refundReason: 'no_ack' }));
  });
});

describe('sweepPendingRedemptionAcks', () => {
  it('refunds every pending redemption with the restart reason', async () => {
    vi.mocked(listPendingRedemptionAcks).mockResolvedValueOnce(['red1', 'red2']);
    expect(await sweepPendingRedemptionAcks()).toBe(2);
    expect(claimRedemptionAck).toHaveBeenCalledWith('red1', expect.objectContaining({ refundReason: 'restart' }));
    expect(claimRedemptionAck).toHaveBeenCalledWith('red2', expect.objectContaining({ refundReason: 'restart' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('skips redemptions with a live timer, and retries one whose refund failed later', async () => {
    vi.useFakeTimers();
    trackRedemptionAck('red1', 'streamer');
    vi.mocked(listPendingRedemptionAcks).mockResolvedValueOnce(['red1', 'red2']);
    vi.mocked(claimRedemptionAck).mockRejectedValueOnce(new Error('db down'));

    expect(await sweepPendingRedemptionAcks()).toBe(0);
    expect(claimRedemptionAck).toHaveBeenCalledTimes(1);
    expect(claimRedemptionAck).toHaveBeenCalledWith('red2', expect.anything());

    await vi.advanceTimersByTimeAsync(REDEMPTION_ACK_TIMEOUT_MS);
    expect(claimRedemptionAck).toHaveBeenCalledWith('red1', expect.objectContaining({ refundReason: 'no_ack' }));
    expect(claimRedemptionAck).toHaveBeenCalledWith('red2', expect.objectContaining({ refundReason: 'restart' }));
  });
});
