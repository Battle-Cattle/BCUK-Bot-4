import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../db', () => ({
  countAdvancedCommandUses: vi.fn(),
  getAdvancedCommand: vi.fn(),
  getAdvancedCommandForTwitchChannel: vi.fn(),
  getLoyaltyPointsBalance: vi.fn(),
  getLoyaltyPointsConfig: vi.fn(),
  isExcludedFromLoyaltyPoints: vi.fn(),
  recordAdvancedCommandUsage: vi.fn(),
  adjustLoyaltyPointsBalance: vi.fn(),
  spendLoyaltyPoints: vi.fn(),
}));
vi.mock('../../twitch/monitor/twitchMonitor', () => ({ getChannelStreamStart: vi.fn(), isChannelLive: vi.fn() }));
vi.mock('./advancedCommandEffects', () => ({ runAdvancedCommandEffects: vi.fn() }));
vi.mock('./advancedCommandRefunds', () => ({ refundAdvancedCommandUse: vi.fn(), trackAdvancedCommandAck: vi.fn() }));

import * as db from '../../db';
import type { DbAdvancedCommand } from '../../db';
import { getChannelStreamStart, isChannelLive } from '../../twitch/monitor/twitchMonitor';
import { runAdvancedCommandEffects } from './advancedCommandEffects';
import { refundAdvancedCommandUse, trackAdvancedCommandAck } from './advancedCommandRefunds';
import { registerAdvancedCommandRuntime } from './advancedCommandRuntime';
import {
  executeAdvancedCommandForTwitch, triggerAdvancedCommandFromStreamDeck, clearAdvancedCommandState,
  OFFLINE_USAGE_WINDOW_MS, type AdvancedCommandChatMessage,
} from './advancedCommandHandler';

const send = vi.fn();
const ROUTE = { commandId: 7, streamerId: 3, triggerString: '!hydrate', twitchName: 'streamer', discordId: '99' };
const START = new Date('2026-10-15T18:00:00Z');

function command(overrides: Partial<DbAdvancedCommand> = {}): DbAdvancedCommand {
  return {
    id: 7, streamerId: 3, name: 'Hydrate', triggerString: '!hydrate', isEnabled: true, response: null,
    pointCost: 100, priceStep: 0, maxCost: null, globalCooldownSeconds: 0, userCooldownSeconds: 0,
    minRole: 'everyone', liveOnly: false, maxUsesPerStream: null, maxUsesPerUserPerStream: null,
    companionEnabled: true, params: [], videos: [], alert: null,
    ...overrides,
  };
}

function message(overrides: Partial<AdvancedCommandChatMessage> = {}): AdvancedCommandChatMessage {
  return {
    channel: 'streamer', userLogin: 'alice', userName: 'Alice', message: '!hydrate now', command: '!hydrate',
    roles: { isBroadcaster: false, isMod: false, isVip: false, isSubscriber: false },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAdvancedCommandState();
  send.mockResolvedValue(undefined);
  registerAdvancedCommandRuntime({ send, hasCompanionConnection: vi.fn() });
  vi.mocked(db.getAdvancedCommandForTwitchChannel).mockResolvedValue(ROUTE);
  vi.mocked(db.getAdvancedCommand).mockResolvedValue(command());
  vi.mocked(db.getLoyaltyPointsConfig).mockResolvedValue({ enabled: true } as any);
  vi.mocked(db.isExcludedFromLoyaltyPoints).mockResolvedValue(false);
  vi.mocked(db.spendLoyaltyPoints).mockResolvedValue(400);
  vi.mocked(db.countAdvancedCommandUses).mockResolvedValue(0);
  vi.mocked(getChannelStreamStart).mockReturnValue(START);
  vi.mocked(isChannelLive).mockReturnValue(true);
  vi.mocked(runAdvancedCommandEffects).mockResolvedValue('pushed');
});

describe('executeAdvancedCommandForTwitch', () => {
  it('charges, records, fires and waits for the companion acknowledgement', async () => {
    await executeAdvancedCommandForTwitch(message());

    expect(db.spendLoyaltyPoints).toHaveBeenCalledWith(3, 'alice', 100);
    expect(db.recordAdvancedCommandUsage).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 7, streamerId: 3, source: 'chat', twitchUsername: 'alice', pointsSpent: 100,
      streamStartedAt: START, status: 'pending',
    }));
    const use = vi.mocked(runAdvancedCommandEffects).mock.calls[0]![0];
    expect(use).toMatchObject({ channel: 'streamer', discordId: '99', userName: 'Alice', args: 'now', balance: 400 });
    expect(trackAdvancedCommandAck).toHaveBeenCalledWith(use.eventId, 'streamer');
  });

  it('ignores messages with no command or no matching route', async () => {
    await executeAdvancedCommandForTwitch(message({ command: null }));
    vi.mocked(db.getAdvancedCommandForTwitchChannel).mockResolvedValueOnce(null);
    await executeAdvancedCommandForTwitch(message());
    expect(db.getAdvancedCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled', () => vi.mocked(db.getAdvancedCommand).mockResolvedValue(command({ isEnabled: false }))],
    ['deleted', () => vi.mocked(db.getAdvancedCommand).mockResolvedValue(null)],
    ['below the role', () => vi.mocked(db.getAdvancedCommand).mockResolvedValue(command({ minRole: 'vip' }))],
    ['live-only while offline', () => {
      vi.mocked(db.getAdvancedCommand).mockResolvedValue(command({ liveOnly: true }));
      vi.mocked(isChannelLive).mockReturnValue(false);
    }],
  ])('silently ignores a %s command', async (_label, setup) => {
    setup();
    await executeAdvancedCommandForTwitch(message());
    expect(db.spendLoyaltyPoints).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('enforces cooldowns with one notice, not charging again', async () => {
    vi.mocked(db.getAdvancedCommand).mockResolvedValue(command({ userCooldownSeconds: 60 }));
    await executeAdvancedCommandForTwitch(message());
    await executeAdvancedCommandForTwitch(message());
    await executeAdvancedCommandForTwitch(message());
    expect(db.spendLoyaltyPoints).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]).toMatch(/^@alice Hydrate is on cooldown — try again in \d+s\.$/);
  });

  it('refuses once the per-stream cap is reached', async () => {
    vi.mocked(db.getAdvancedCommand).mockResolvedValue(command({ maxUsesPerStream: 3 }));
    vi.mocked(db.countAdvancedCommandUses).mockResolvedValue(3);
    await executeAdvancedCommandForTwitch(message());
    expect(db.countAdvancedCommandUses).toHaveBeenCalledWith(7, { streamStartedAt: START });
    expect(db.spendLoyaltyPoints).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('streamer', 'Hydrate has been used the maximum 3 times this stream.');
  });

  it('refuses once the viewer has hit their own cap, counting offline uses over a rolling window', async () => {
    vi.mocked(getChannelStreamStart).mockReturnValue(null);
    vi.mocked(db.getAdvancedCommand).mockResolvedValue(command({ maxUsesPerUserPerStream: 1 }));
    vi.mocked(db.countAdvancedCommandUses).mockResolvedValue(1);
    const before = Date.now();
    await executeAdvancedCommandForTwitch(message());
    const [, window, login] = vi.mocked(db.countAdvancedCommandUses).mock.calls[0]!;
    expect(login).toBe('alice');
    const since = (window as { offlineSince: Date }).offlineSince.getTime();
    expect(since).toBeGreaterThanOrEqual(before - OFFLINE_USAGE_WINDOW_MS);
    expect(send.mock.calls[0]![1]).toContain("you've used Hydrate as many times as you can");
  });

  it('charges the escalated price', async () => {
    vi.mocked(db.getAdvancedCommand).mockResolvedValue(command({ priceStep: 50, maxCost: 180 }));
    vi.mocked(db.countAdvancedCommandUses).mockResolvedValue(1);
    await executeAdvancedCommandForTwitch(message());
    expect(db.spendLoyaltyPoints).toHaveBeenCalledWith(3, 'alice', 150);
  });

  it('tells the viewer when they can\'t afford it', async () => {
    vi.mocked(db.spendLoyaltyPoints).mockResolvedValue(null);
    vi.mocked(db.getLoyaltyPointsBalance).mockResolvedValue(30);
    await executeAdvancedCommandForTwitch(message());
    expect(send).toHaveBeenCalledWith('streamer', '@alice Hydrate costs 100 points — you have 30.');
    expect(db.recordAdvancedCommandUsage).not.toHaveBeenCalled();
  });

  it('stays silent for a paid command when loyalty points are off or the viewer is excluded', async () => {
    vi.mocked(db.getLoyaltyPointsConfig).mockResolvedValueOnce(null);
    await executeAdvancedCommandForTwitch(message());
    vi.mocked(db.isExcludedFromLoyaltyPoints).mockResolvedValueOnce(true);
    await executeAdvancedCommandForTwitch(message());
    expect(db.spendLoyaltyPoints).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('runs a free command without touching loyalty points, needing no acknowledgement', async () => {
    vi.mocked(db.getAdvancedCommand).mockResolvedValue(command({ pointCost: 0, companionEnabled: false }));
    vi.mocked(runAdvancedCommandEffects).mockResolvedValue('disabled');
    await executeAdvancedCommandForTwitch(message());
    expect(db.getLoyaltyPointsConfig).not.toHaveBeenCalled();
    expect(db.recordAdvancedCommandUsage).toHaveBeenCalledWith(expect.objectContaining({ pointsSpent: 0, status: 'no_ack_needed' }));
    expect(trackAdvancedCommandAck).not.toHaveBeenCalled();
    expect(refundAdvancedCommandUse).not.toHaveBeenCalled();
  });

  it('refunds straight away when no companion app is connected', async () => {
    vi.mocked(runAdvancedCommandEffects).mockResolvedValue('no_companion');
    await executeAdvancedCommandForTwitch(message());
    const { eventId } = vi.mocked(runAdvancedCommandEffects).mock.calls[0]![0];
    expect(refundAdvancedCommandUse).toHaveBeenCalledWith(eventId, 'no_companion', { channel: 'streamer' });
  });

  it('credits the points back and rethrows when recording the use fails', async () => {
    vi.mocked(db.recordAdvancedCommandUsage).mockRejectedValueOnce(new Error('DB down'));
    await expect(executeAdvancedCommandForTwitch(message())).rejects.toThrow('DB down');
    expect(db.adjustLoyaltyPointsBalance).toHaveBeenCalledWith(3, 'alice', 100);
    expect(runAdvancedCommandEffects).not.toHaveBeenCalled();
  });
});

describe('triggerAdvancedCommandFromStreamDeck', () => {
  const streamer = { id: 3, discordId: '99', twitchName: 'Streamer' };

  it('fires free, skipping the gates', async () => {
    vi.mocked(db.getAdvancedCommand).mockResolvedValue(command({ minRole: 'moderator', liveOnly: true, maxUsesPerStream: 1 }));
    vi.mocked(isChannelLive).mockReturnValue(false);
    expect(await triggerAdvancedCommandFromStreamDeck(streamer, 7)).toBe('ok');
    expect(db.getAdvancedCommand).toHaveBeenCalledWith(3, 7);
    expect(db.spendLoyaltyPoints).not.toHaveBeenCalled();
    expect(db.countAdvancedCommandUses).not.toHaveBeenCalled();
    expect(db.recordAdvancedCommandUsage).toHaveBeenCalledWith(expect.objectContaining({
      source: 'streamdeck', twitchUsername: null, pointsSpent: 0,
    }));
    expect(vi.mocked(runAdvancedCommandEffects).mock.calls[0]![0]).toMatchObject({ channel: 'streamer', userName: 'Streamer' });
  });

  it('reports a missing or disabled command', async () => {
    vi.mocked(db.getAdvancedCommand).mockResolvedValueOnce(null);
    expect(await triggerAdvancedCommandFromStreamDeck(streamer, 7)).toBe('command_not_found');
    vi.mocked(db.getAdvancedCommand).mockResolvedValueOnce(command({ isEnabled: false }));
    expect(await triggerAdvancedCommandFromStreamDeck(streamer, 7)).toBe('command_disabled');
    expect(runAdvancedCommandEffects).not.toHaveBeenCalled();
  });
});
