import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db', () => ({
  getLoyaltyPointsConfig: vi.fn(),
  adjustLoyaltyPointsBalance: vi.fn(),
  DEFAULT_POINTS_PER_MESSAGE: 1,
  DEFAULT_POINTS_COOLDOWN_SECONDS: 60,
  DEFAULT_POINTS_PER_SUB: 100,
  DEFAULT_POINTS_PER_GIFT_SUB: 100,
}));

import { getLoyaltyPointsConfig, adjustLoyaltyPointsBalance } from '../db';
import {
  awardPointsForChatMessage, tryClaimPointsCooldown, clearPointsCooldowns,
  awardPointsForSub, awardPointsForGiftSub,
} from './pointsEarnHandler';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  clearPointsCooldowns();
  vi.mocked(getLoyaltyPointsConfig).mockResolvedValue(null);
  vi.mocked(adjustLoyaltyPointsBalance).mockResolvedValue(0);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── tryClaimPointsCooldown ───────────────────────────────────────────────────

describe('tryClaimPointsCooldown', () => {
  it('succeeds on the first claim for a (streamer, viewer) pair', () => {
    expect(tryClaimPointsCooldown(1, 'viewer', 60)).toBe(true);
  });

  it('fails on a second claim within the cooldown window', () => {
    tryClaimPointsCooldown(1, 'viewer', 60);
    expect(tryClaimPointsCooldown(1, 'viewer', 60)).toBe(false);
  });

  it('succeeds again once the cooldown has elapsed', () => {
    tryClaimPointsCooldown(1, 'viewer', 60);
    vi.advanceTimersByTime(60_000);
    expect(tryClaimPointsCooldown(1, 'viewer', 60)).toBe(true);
  });

  it('does not share cooldown state between different streamers for the same viewer', () => {
    tryClaimPointsCooldown(1, 'viewer', 60);
    expect(tryClaimPointsCooldown(2, 'viewer', 60)).toBe(true);
  });

  it('does not share cooldown state between different viewers on the same streamer', () => {
    tryClaimPointsCooldown(1, 'alice', 60);
    expect(tryClaimPointsCooldown(1, 'bob', 60)).toBe(true);
  });

  it('honors a shorter configured cooldown', () => {
    tryClaimPointsCooldown(1, 'viewer', 10);
    vi.advanceTimersByTime(10_000);
    expect(tryClaimPointsCooldown(1, 'viewer', 10)).toBe(true);
  });
});

// ─── awardPointsForChatMessage ────────────────────────────────────────────────

describe('awardPointsForChatMessage', () => {
  it('awards the default points-per-message when the streamer has no configuration', async () => {
    await awardPointsForChatMessage(1, 'viewer');
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'viewer', 1);
  });

  it('awards the streamer\'s configured points-per-message', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ pointsPerMessage: 5, cooldownSeconds: 60, pointsPerSub: 100, pointsPerGiftSub: 100 });
    await awardPointsForChatMessage(1, 'viewer');
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'viewer', 5);
  });

  it('does not award on a second message within the cooldown window', async () => {
    await awardPointsForChatMessage(1, 'viewer');
    await awardPointsForChatMessage(1, 'viewer');
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledOnce();
  });

  it('awards again once the cooldown has elapsed', async () => {
    await awardPointsForChatMessage(1, 'viewer');
    vi.advanceTimersByTime(60_000);
    await awardPointsForChatMessage(1, 'viewer');
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledTimes(2);
  });

  it('honors the streamer\'s configured cooldown instead of the default', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ pointsPerMessage: 1, cooldownSeconds: 5, pointsPerSub: 100, pointsPerGiftSub: 100 });
    await awardPointsForChatMessage(1, 'viewer');
    vi.advanceTimersByTime(5_000);
    await awardPointsForChatMessage(1, 'viewer');
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledTimes(2);
  });

  it('tracks cooldowns independently per streamer', async () => {
    await awardPointsForChatMessage(1, 'viewer');
    await awardPointsForChatMessage(2, 'viewer');
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledTimes(2);
  });
});

// ─── awardPointsForSub ────────────────────────────────────────────────────────

describe('awardPointsForSub', () => {
  it('awards the default points-per-sub when the streamer has no configuration', async () => {
    await awardPointsForSub(1, 'subscriber');
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'subscriber', 100);
  });

  it('awards the streamer\'s configured points-per-sub', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ pointsPerMessage: 1, cooldownSeconds: 60, pointsPerSub: 250, pointsPerGiftSub: 100 });
    await awardPointsForSub(1, 'subscriber');
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'subscriber', 250);
  });

  it('is not subject to the chat-earn cooldown', async () => {
    await awardPointsForSub(1, 'subscriber');
    await awardPointsForSub(1, 'subscriber');
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledTimes(2);
  });
});

// ─── awardPointsForGiftSub ────────────────────────────────────────────────────

describe('awardPointsForGiftSub', () => {
  it('awards the default points-per-gift-sub, scaled by count, when the streamer has no configuration', async () => {
    await awardPointsForGiftSub(1, 'gifter', 5);
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'gifter', 500);
  });

  it('awards the streamer\'s configured points-per-gift-sub, scaled by count', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ pointsPerMessage: 1, cooldownSeconds: 60, pointsPerSub: 100, pointsPerGiftSub: 10 });
    await awardPointsForGiftSub(1, 'gifter', 5);
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'gifter', 50);
  });

  it('scales correctly for a single gifted sub', async () => {
    await awardPointsForGiftSub(1, 'gifter', 1);
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'gifter', 100);
  });
});
