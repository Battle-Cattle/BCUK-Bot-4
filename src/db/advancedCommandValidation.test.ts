import { describe, it, expect, vi } from 'vitest';

// alertConfig.ts (for the animation list) imports the pool, whose real config chain needs env vars.
vi.mock('./pool', () => ({ getPool: vi.fn(), withTransaction: vi.fn() }));

import {
  normalizeAdvancedCommandSettings,
  normalizeAdvancedCommandEffects,
  normalizeAdvancedTrigger,
  AdvancedCommandValidationError,
  type AdvancedCommandSettings,
} from './advancedCommandValidation';
import { ReservedCommandError } from './reservedCommands';

function settings(overrides: Partial<AdvancedCommandSettings> = {}): AdvancedCommandSettings {
  return {
    name: 'Hydrate',
    triggerString: '!Hydrate',
    isEnabled: true,
    response: null,
    pointCost: 100,
    priceStep: 0,
    maxCost: null,
    globalCooldownSeconds: 0,
    userCooldownSeconds: 0,
    minRole: 'everyone',
    liveOnly: false,
    maxUsesPerStream: null,
    maxUsesPerUserPerStream: null,
    companionEnabled: true,
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof AdvancedCommandValidationError ? err.code : (err as Error).name;
  }
  return undefined;
}

describe('normalizeAdvancedCommandSettings', () => {
  it('trims the name, lowercases the trigger and nulls a blank response', () => {
    const result = normalizeAdvancedCommandSettings(settings({ name: '  Hydrate ', response: '   ' }));
    expect(result).toMatchObject({ name: 'Hydrate', triggerString: '!hydrate', response: null });
  });

  it('treats a blank trigger as Stream Deck only', () => {
    expect(normalizeAdvancedCommandSettings(settings({ triggerString: '  ' })).triggerString).toBeNull();
    expect(normalizeAdvancedCommandSettings(settings({ triggerString: null })).triggerString).toBeNull();
  });

  it.each([
    [{ name: '' }, 'invalid_name'],
    [{ name: 'x'.repeat(65) }, 'invalid_name'],
    [{ triggerString: '!two words' }, 'invalid_trigger'],
    [{ triggerString: 'pingpong' }, 'invalid_trigger'],
    [{ triggerString: '?pingpong' }, 'invalid_trigger'],
    [{ response: 'x'.repeat(2001) }, 'invalid_response'],
    [{ pointCost: -1 }, 'invalid_point_cost'],
    [{ pointCost: 1.5 }, 'invalid_point_cost'],
    [{ priceStep: -5 }, 'invalid_price_step'],
    [{ maxCost: 50 }, 'invalid_max_cost'],
    [{ globalCooldownSeconds: -1 }, 'invalid_global_cooldown'],
    [{ userCooldownSeconds: Number.NaN }, 'invalid_user_cooldown'],
    [{ maxUsesPerStream: 0 }, 'invalid_max_uses'],
    [{ maxUsesPerUserPerStream: 0 }, 'invalid_max_user_uses'],
    [{ minRole: 'owner' as never }, 'invalid_role'],
  ])('rejects %o with %s', (override, code) => {
    expect(codeOf(() => normalizeAdvancedCommandSettings(settings(override)))).toBe(code);
  });

  it('accepts a max cost equal to the base cost and positive caps', () => {
    expect(() => normalizeAdvancedCommandSettings(settings({ maxCost: 100, maxUsesPerStream: 1, maxUsesPerUserPerStream: 1 }))).not.toThrow();
  });
});

describe('normalizeAdvancedTrigger', () => {
  it('rejects a built-in command', () => {
    expect(() => normalizeAdvancedTrigger('!Points')).toThrow(ReservedCommandError);
  });

  it.each([['!PingPong', '!pingpong'], ['#Hydrate', '#hydrate']])('accepts %s, a prefixed trigger', (trigger, expected) => {
    expect(normalizeAdvancedTrigger(trigger)).toBe(expected);
  });
});

describe('normalizeAdvancedCommandEffects', () => {
  it('trims params, drops duplicate videos and clamps weights', () => {
    const result = normalizeAdvancedCommandEffects({
      params: [{ key: ' color ', value: ' red ' }],
      videos: [{ videoId: 1, weight: 0 }, { videoId: 1, weight: 5 }, { videoId: 2, weight: 5000 }, { videoId: 2.5, weight: 1 }],
      alert: null,
    });
    expect(result.params).toEqual([{ key: 'color', value: 'red' }]);
    expect(result.videos).toEqual([{ videoId: 1, weight: 1 }, { videoId: 2, weight: 1000 }]);
  });

  it.each([
    [{ params: Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, value: 'v' })) }, 'too_many_params'],
    [{ params: [{ key: 'bad key', value: 'v' }] }, 'invalid_param'],
    [{ params: [{ key: 'a', value: '1' }, { key: 'a', value: '2' }] }, 'invalid_param'],
    [{ params: [{ key: 'a', value: 'x'.repeat(256) }] }, 'invalid_param'],
    [{ alert: { messageTemplate: ' ', durationMs: 1000, textAnimation: 'none' as const } }, 'invalid_alert_message'],
    [{ alert: { messageTemplate: 'hi', durationMs: 0, textAnimation: 'none' as const } }, 'invalid_alert_duration'],
    [{ alert: { messageTemplate: 'hi', durationMs: 1000, textAnimation: 'spin' as never } }, 'invalid_alert_animation'],
  ])('rejects %o with %s', (override, code) => {
    const effects = { params: [], videos: [], alert: null, ...override };
    expect(codeOf(() => normalizeAdvancedCommandEffects(effects))).toBe(code);
  });

  it('trims the alert message', () => {
    const result = normalizeAdvancedCommandEffects({
      params: [], videos: [], alert: { messageTemplate: ' {user} hydrated ', durationMs: 5000, textAnimation: 'wave' },
    });
    expect(result.alert).toEqual({ messageTemplate: '{user} hydrated', durationMs: 5000, textAnimation: 'wave' });
  });
});
