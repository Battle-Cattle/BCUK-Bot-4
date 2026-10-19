import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db', () => ({
  getLoyaltyPointsConfig: vi.fn(),
  adjustLoyaltyPointsBalance: vi.fn(),
  isExcludedFromLoyaltyPoints: vi.fn(),
}));

import { getLoyaltyPointsConfig, adjustLoyaltyPointsBalance, isExcludedFromLoyaltyPoints } from '../db';
import {
  awardPointsForChatMessage, clearPointsCooldowns,
  awardPointsForSub, awardPointsForGiftSub,
} from './pointsEarnHandler';

const ENABLED_CONFIG = { enabled: true, pointsPerMessage: 1, cooldownSeconds: 60, pointsPerSub: 100, pointsPerGiftSub: 100 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  clearPointsCooldowns();
  vi.mocked(getLoyaltyPointsConfig).mockResolvedValue(ENABLED_CONFIG);
  vi.mocked(adjustLoyaltyPointsBalance).mockResolvedValue(0);
  vi.mocked(isExcludedFromLoyaltyPoints).mockResolvedValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── awardPointsForChatMessage ────────────────────────────────────────────────

describe('awardPointsForChatMessage', () => {
  it('does not award when the streamer has no configuration (not opted in)', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue(null);
    await awardPointsForChatMessage(1, 'viewer');
    expect(adjustLoyaltyPointsBalance).not.toHaveBeenCalled();
  });

  it('does not award when the streamer has a config row but enabled is false', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ ...ENABLED_CONFIG, enabled: false });
    await awardPointsForChatMessage(1, 'viewer');
    expect(adjustLoyaltyPointsBalance).not.toHaveBeenCalled();
  });

  it('awards the streamer\'s configured points-per-message', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ enabled: true, pointsPerMessage: 5, cooldownSeconds: 60, pointsPerSub: 100, pointsPerGiftSub: 100 });
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
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ enabled: true, pointsPerMessage: 1, cooldownSeconds: 5, pointsPerSub: 100, pointsPerGiftSub: 100 });
    await awardPointsForChatMessage(1, 'viewer');
    vi.advanceTimersByTime(5_000);
    await awardPointsForChatMessage(1, 'viewer');
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledTimes(2);
  });

  it('does not award an excluded bot, and leaves its cooldown unclaimed', async () => {
    vi.mocked(isExcludedFromLoyaltyPoints).mockResolvedValue(true);
    await awardPointsForChatMessage(1, 'somebot');
    expect(isExcludedFromLoyaltyPoints).toHaveBeenCalledWith(1, 'somebot');
    expect(adjustLoyaltyPointsBalance).not.toHaveBeenCalled();

    vi.mocked(isExcludedFromLoyaltyPoints).mockResolvedValue(false);
    await awardPointsForChatMessage(1, 'somebot');
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'somebot', 1);
  });

  it('tracks cooldowns independently per streamer', async () => {
    await awardPointsForChatMessage(1, 'viewer');
    await awardPointsForChatMessage(2, 'viewer');
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledTimes(2);
  });
});

// ─── awardPointsForSub ────────────────────────────────────────────────────────

describe('awardPointsForSub', () => {
  it('does not award when the streamer has no configuration (not opted in)', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue(null);
    await awardPointsForSub(1, 'subscriber');
    expect(adjustLoyaltyPointsBalance).not.toHaveBeenCalled();
  });

  it('does not award when enabled is false', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ ...ENABLED_CONFIG, enabled: false });
    await awardPointsForSub(1, 'subscriber');
    expect(adjustLoyaltyPointsBalance).not.toHaveBeenCalled();
  });

  it('awards the streamer\'s configured points-per-sub', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ enabled: true, pointsPerMessage: 1, cooldownSeconds: 60, pointsPerSub: 250, pointsPerGiftSub: 100 });
    await awardPointsForSub(1, 'subscriber');
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'subscriber', 250);
  });

  it('does not award an excluded bot', async () => {
    vi.mocked(isExcludedFromLoyaltyPoints).mockResolvedValue(true);
    await awardPointsForSub(1, 'somebot');
    expect(isExcludedFromLoyaltyPoints).toHaveBeenCalledWith(1, 'somebot');
    expect(adjustLoyaltyPointsBalance).not.toHaveBeenCalled();
  });

  it('is not subject to the chat-earn cooldown', async () => {
    await awardPointsForSub(1, 'subscriber');
    await awardPointsForSub(1, 'subscriber');
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledTimes(2);
  });
});

// ─── awardPointsForGiftSub ────────────────────────────────────────────────────

describe('awardPointsForGiftSub', () => {
  it('does not award when the streamer has no configuration (not opted in)', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue(null);
    await awardPointsForGiftSub(1, 'gifter', 5);
    expect(adjustLoyaltyPointsBalance).not.toHaveBeenCalled();
  });

  it('does not award when enabled is false', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ ...ENABLED_CONFIG, enabled: false });
    await awardPointsForGiftSub(1, 'gifter', 5);
    expect(adjustLoyaltyPointsBalance).not.toHaveBeenCalled();
  });

  it('awards the streamer\'s configured points-per-gift-sub, scaled by count', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ enabled: true, pointsPerMessage: 1, cooldownSeconds: 60, pointsPerSub: 100, pointsPerGiftSub: 10 });
    await awardPointsForGiftSub(1, 'gifter', 5);
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'gifter', 50);
  });

  it('does not award an excluded bot', async () => {
    vi.mocked(isExcludedFromLoyaltyPoints).mockResolvedValue(true);
    await awardPointsForGiftSub(1, 'somebot', 5);
    expect(isExcludedFromLoyaltyPoints).toHaveBeenCalledWith(1, 'somebot');
    expect(adjustLoyaltyPointsBalance).not.toHaveBeenCalled();
  });

  it('scales correctly for a single gifted sub', async () => {
    await awardPointsForGiftSub(1, 'gifter', 1);
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'gifter', 100);
  });
});
