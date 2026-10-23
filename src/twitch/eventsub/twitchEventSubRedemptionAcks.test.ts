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
vi.mock('../twitchRewardsApi', () => {
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
import { updateRedemptionStatus, TwitchRedemptionNotFoundError } from '../twitchRewardsApi';
import { revertRedemptionPricing } from '../pricing/rewardPricingService';
import { registerEventSubCompanionRuntime, registerEventSubTwitchRuntime } from './twitchEventSubRuntime';
import {
  REDEMPTION_ACK_TIMEOUT_MS, prepareRedemptionConfirmation, refundRedemption, trackRedemptionAck,
  pushRedemptionForConfirmation, acknowledgeRedemption, sweepPendingRedemptionAcks, clearRedemptionAcks,
  extendRedemptionAck,
} from './twitchEventSubRedemptionAcks';
import { ACK_MAX_HOLD_MS } from '../../shared/ackHold';
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
  vi.mocked(recordPendingRedemptionAck).mockResolvedValue(true);
});

afterEach(() => {
  clearRedemptionAcks();
  vi.useRealTimers();
});

describe('prepareRedemptionConfirmation', () => {
  const redemption = { id: 'red1', rewardId: 'rwd1', rewardTitle: 'Lights', userLogin: 'alice' };

  it('records nothing when the reward does not require confirmation', async () => {
    vi.mocked(isCompanionConfirmationRequired).mockResolvedValueOnce(false);
    expect(await prepareRedemptionConfirmation(redemption, 3, 'streamer')).toBe('none');
    expect(recordPendingRedemptionAck).not.toHaveBeenCalled();
  });

  it('arms the refund timer as soon as the pending row is recorded', async () => {
    vi.useFakeTimers();
    vi.mocked(isCompanionConfirmationRequired).mockResolvedValueOnce(true);
    await prepareRedemptionConfirmation(redemption, 3, 'streamer');

    await vi.advanceTimersByTimeAsync(REDEMPTION_ACK_TIMEOUT_MS);
    expect(claimRedemptionAck).toHaveBeenCalledWith('red1', expect.objectContaining({ refundReason: 'no_ack' }));
    expect(send).toHaveBeenCalledWith('streamer', expect.stringContaining("didn't respond"));
  });

  it('arms no timer when recording the pending row fails', async () => {
    vi.useFakeTimers();
    vi.mocked(isCompanionConfirmationRequired).mockResolvedValueOnce(true);
    vi.mocked(recordPendingRedemptionAck).mockRejectedValueOnce(new Error('db down'));
    await expect(prepareRedemptionConfirmation(redemption, 3, 'streamer')).rejects.toThrow('db down');

    await vi.advanceTimersByTimeAsync(REDEMPTION_ACK_TIMEOUT_MS);
    expect(claimRedemptionAck).not.toHaveBeenCalled();
  });

  it('reports an already-resolved retry and arms no timer for it', async () => {
    vi.useFakeTimers();
    vi.mocked(isCompanionConfirmationRequired).mockResolvedValueOnce(true);
    vi.mocked(recordPendingRedemptionAck).mockResolvedValueOnce(false);
    expect(await prepareRedemptionConfirmation(redemption, 3, 'streamer')).toBe('resolved');

    await vi.advanceTimersByTimeAsync(REDEMPTION_ACK_TIMEOUT_MS);
    expect(claimRedemptionAck).not.toHaveBeenCalled();
  });

  it('records the redemption as pending when the reward requires confirmation', async () => {
    vi.mocked(isCompanionConfirmationRequired).mockResolvedValueOnce(true);
    expect(await prepareRedemptionConfirmation(redemption, 3, 'streamer')).toBe('pending');
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
  it('gives the companion app minutes, not seconds, so slow actions are not refunded mid-run', async () => {
    vi.useFakeTimers();
    trackRedemptionAck('red1', 'streamer');

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(claimRedemptionAck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claimRedemptionAck).toHaveBeenCalledWith('red1', expect.objectContaining({ refundReason: 'no_ack' }));
  });

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

  it('retries a transient failure to mark it fulfilled, never refunding (the actions ran)', async () => {
    vi.useFakeTimers();
    vi.mocked(updateRedemptionStatus).mockRejectedValueOnce(new Error('503')).mockRejectedValueOnce(new Error('503'));

    expect(await acknowledgeRedemption('red1', { ok: true })).toBe(true);
    expect(updateRedemptionStatus).toHaveBeenCalledTimes(1);
    // Fulfilment retries are 30s apart, independent of the (much longer) acknowledgement timeout.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(updateRedemptionStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(updateRedemptionStatus).toHaveBeenCalledTimes(3);
    expect(updateRedemptionStatus).toHaveBeenLastCalledWith('bc1', 'rwd1', 'red1', 'FULFILLED', 'user-token');

    expect(releaseRedemptionAck).not.toHaveBeenCalled();
    expect(claimRedemptionAck).toHaveBeenCalledTimes(1);
  });

  it('gives up after three failed attempts, and does not retry a permanent refusal', async () => {
    vi.useFakeTimers();
    vi.mocked(updateRedemptionStatus).mockRejectedValue(new Error('503'));
    await acknowledgeRedemption('red1', { ok: true });
    await vi.advanceTimersByTimeAsync(REDEMPTION_ACK_TIMEOUT_MS * 5);
    expect(updateRedemptionStatus).toHaveBeenCalledTimes(3);

    vi.mocked(updateRedemptionStatus).mockReset().mockRejectedValueOnce(new TwitchRedemptionNotFoundError('gone'));
    expect(await acknowledgeRedemption('red1', { ok: true })).toBe(true);
    await vi.advanceTimersByTimeAsync(REDEMPTION_ACK_TIMEOUT_MS * 2);
    expect(updateRedemptionStatus).toHaveBeenCalledTimes(1);
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

describe('extendRedemptionAck', () => {
  afterEach(() => {
    clearRedemptionAcks();
    vi.useRealTimers();
  });

  it('restarts the countdown, so a redemption pinged before the timeout is not refunded', async () => {
    vi.useFakeTimers();
    trackRedemptionAck('red1', 'streamer');
    vi.advanceTimersByTime(REDEMPTION_ACK_TIMEOUT_MS - 1_000);
    expect(extendRedemptionAck('red1')).toBe(true);
    vi.advanceTimersByTime(REDEMPTION_ACK_TIMEOUT_MS - 1_000);
    await flushMicrotasks();
    expect(claimRedemptionAck).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    await flushMicrotasks();
    expect(claimRedemptionAck).toHaveBeenCalledWith('red1', expect.objectContaining({ refundReason: 'no_ack' }));
  });

  it('does nothing for a redemption that is not waiting', () => {
    expect(extendRedemptionAck('unknown')).toBe(false);
  });

  it('stops extending once the redemption has been held for ACK_MAX_HOLD_MS', () => {
    vi.useFakeTimers();
    trackRedemptionAck('red1', 'streamer');
    vi.advanceTimersByTime(REDEMPTION_ACK_TIMEOUT_MS - 1);
    for (let held = REDEMPTION_ACK_TIMEOUT_MS - 1; held < ACK_MAX_HOLD_MS; held += REDEMPTION_ACK_TIMEOUT_MS - 1) {
      expect(extendRedemptionAck('red1')).toBe(true);
      vi.advanceTimersByTime(REDEMPTION_ACK_TIMEOUT_MS - 1);
    }
    expect(extendRedemptionAck('red1')).toBe(false);
  });
});

describe('extendRedemptionAck at the edges', () => {
  afterEach(() => {
    clearRedemptionAcks();
    vi.useRealTimers();
  });

  it('caps a late ping\'s timer at the time left before the hold boundary', async () => {
    vi.useFakeTimers();
    trackRedemptionAck('red1', 'streamer');
    let held = 0;
    while (held + REDEMPTION_ACK_TIMEOUT_MS / 2 < ACK_MAX_HOLD_MS - 5_000) {
      vi.advanceTimersByTime(REDEMPTION_ACK_TIMEOUT_MS / 2);
      held += REDEMPTION_ACK_TIMEOUT_MS / 2;
      expect(extendRedemptionAck('red1')).toBe(true);
    }
    vi.advanceTimersByTime(ACK_MAX_HOLD_MS - 5_000 - held);
    expect(extendRedemptionAck('red1')).toBe(true);

    vi.advanceTimersByTime(4_999);
    await flushMicrotasks();
    expect(claimRedemptionAck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(claimRedemptionAck).toHaveBeenCalledWith('red1', expect.objectContaining({ refundReason: 'no_ack' }));
  });

  it('never postpones a refund retry once the acknowledgement has timed out', async () => {
    vi.useFakeTimers();
    vi.mocked(updateRedemptionStatus).mockRejectedValueOnce(new Error('Twitch 503'));
    trackRedemptionAck('red1', 'streamer');
    vi.advanceTimersByTime(REDEMPTION_ACK_TIMEOUT_MS);
    await flushMicrotasks();
    expect(releaseRedemptionAck).toHaveBeenCalledWith('red1');

    expect(extendRedemptionAck('red1')).toBe(false);
    vi.advanceTimersByTime(REDEMPTION_ACK_TIMEOUT_MS);
    await flushMicrotasks();
    expect(claimRedemptionAck).toHaveBeenCalledTimes(2);
  });
});
