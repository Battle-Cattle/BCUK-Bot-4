import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../db', () => ({}));

import { runAdvancedCommandEffects, buildTemplateVars, type AdvancedCommandUse } from './advancedCommandEffects';
import { registerAdvancedCommandRuntime } from './advancedCommandRuntime';
import {
  registerEventSubAlertRuntime, registerEventSubCompanionRuntime, registerEventSubOverlayRuntime,
} from '../../twitch/eventsub/twitchEventSubRuntime';
import type { DbAdvancedCommand } from '../../db';

const send = vi.fn();
const hasCompanionConnection = vi.fn();
const pushCompanionEvent = vi.fn();
const pushOverlayEvent = vi.fn();
const pushAlertEvent = vi.fn();

function command(overrides: Partial<DbAdvancedCommand> = {}): DbAdvancedCommand {
  return {
    id: 7, streamerId: 3, name: 'Hydrate', triggerString: '!hydrate', isEnabled: true, response: null,
    pointCost: 100, priceStep: 0, maxCost: null, globalCooldownSeconds: 0, userCooldownSeconds: 0,
    minRole: 'everyone', liveOnly: false, maxUsesPerStream: null, maxUsesPerUserPerStream: null,
    companionEnabled: false, params: [], videos: [], alert: null,
    ...overrides,
  };
}

function use(overrides: Partial<AdvancedCommandUse> = {}): AdvancedCommandUse {
  return {
    command: command(), eventId: 'e1', channel: 'streamer', discordId: '99', source: 'chat',
    userLogin: 'alice', userName: 'Alice', args: 'big gulp', pointsSpent: 100, balance: 400,
    triggeredAt: new Date('2026-10-15T18:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue(undefined);
  registerAdvancedCommandRuntime({ send, hasCompanionConnection });
  registerEventSubCompanionRuntime({ pushCompanionEvent });
  registerEventSubOverlayRuntime({ pushOverlayEvent });
  registerEventSubAlertRuntime({ pushAlertEvent });
});

describe('buildTemplateVars', () => {
  it('fills user, args, first arg, cost and balance', () => {
    expect(buildTemplateVars(use())).toEqual({ user: 'Alice', args: 'big gulp', arg: 'big', cost: '100', balance: '400' });
    expect(buildTemplateVars(use({ balance: null })).balance).toBe('');
  });
});

describe('runAdvancedCommandEffects', () => {
  it('does nothing but report disabled for a command with no effects', async () => {
    expect(await runAdvancedCommandEffects(use())).toBe('disabled');
    expect(send).not.toHaveBeenCalled();
    expect(pushOverlayEvent).not.toHaveBeenCalled();
    expect(pushAlertEvent).not.toHaveBeenCalled();
    expect(pushCompanionEvent).not.toHaveBeenCalled();
  });

  it('sends the filled chat reply', async () => {
    await runAdvancedCommandEffects(use({ command: command({ response: '{user} paid {cost}, {balance} left: {arg}' }) }));
    expect(send).toHaveBeenCalledWith('streamer', 'Alice paid 100, 400 left: big');
  });

  it('logs and swallows a failed reply', async () => {
    send.mockRejectedValueOnce(new Error('rate limited'));
    await expect(runAdvancedCommandEffects(use({ command: command({ response: 'hi' }) }))).resolves.toBe('disabled');
  });

  it('plays an overlay video and shows the alert', async () => {
    await runAdvancedCommandEffects(use({
      command: command({
        videos: [{ videoId: 1, weight: 1, name: 'Splash', filename: 'v.mp4' }],
        alert: { messageTemplate: '{user} hydrated', imageFilename: 'i.gif', soundFilename: null, durationMs: 4000, textAnimation: 'wave' },
      }),
    }));
    expect(pushOverlayEvent).toHaveBeenCalledWith('streamer', '/overlay/videos/3/v.mp4');
    expect(pushAlertEvent).toHaveBeenCalledWith('streamer', {
      type: 'advanced_command', message: 'Alice hydrated', imageUrl: '/alerts/assets/3/i.gif', soundUrl: null,
      durationMs: 4000, textAnimation: 'wave',
    });
  });

  it('keeps going when an overlay push throws', async () => {
    pushOverlayEvent.mockImplementationOnce(() => { throw new Error('boom'); });
    const result = await runAdvancedCommandEffects(use({
      command: command({ response: 'hi', videos: [{ videoId: 1, weight: 1, name: 'x', filename: 'v.mp4' }] }),
    }));
    expect(result).toBe('disabled');
    expect(send).toHaveBeenCalled();
  });

  it('pushes the companion event with parameters when a companion app is connected', async () => {
    hasCompanionConnection.mockReturnValue(true);
    const result = await runAdvancedCommandEffects(use({
      command: command({ companionEnabled: true, params: [{ key: 'color', value: 'red' }] }),
    }));
    expect(result).toBe('pushed');
    expect(hasCompanionConnection).toHaveBeenCalledWith('99');
    expect(pushCompanionEvent).toHaveBeenCalledWith('99', {
      type: 'advanced_command', id: 'e1', commandId: 7, commandName: 'Hydrate', source: 'chat',
      userLogin: 'alice', userName: 'Alice', args: 'big gulp', pointsSpent: 100,
      parameters: { color: 'red' }, ackRequired: true, triggeredAt: '2026-10-15T18:00:00.000Z',
    });
  });

  it('sends a Stream Deck use with no viewer and no args', async () => {
    hasCompanionConnection.mockReturnValue(true);
    await runAdvancedCommandEffects(use({
      command: command({ companionEnabled: true }), source: 'streamdeck', userLogin: null, userName: 'Streamer', args: '', pointsSpent: 0,
    }));
    expect(pushCompanionEvent.mock.calls[0]![1]).toMatchObject({ source: 'streamdeck', userLogin: null, userName: null, args: null });
  });

  it('reports no_companion when nothing is connected', async () => {
    hasCompanionConnection.mockReturnValue(false);
    expect(await runAdvancedCommandEffects(use({ command: command({ companionEnabled: true }) }))).toBe('no_companion');
    expect(pushCompanionEvent).not.toHaveBeenCalled();
  });
});
