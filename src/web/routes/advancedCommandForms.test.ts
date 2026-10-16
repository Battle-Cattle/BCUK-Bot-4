import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db', async () => {
  const validation = await import('../../db/advancedCommandValidation.js');
  const errors = await import('../../db/commandErrors.js');
  const reserved = await import('../../db/reservedCommands.js');
  class AdvancedCommandConflictError extends Error {
    constructor(readonly field: 'name' | 'trigger') { super(field); }
  }
  return {
    ...validation,
    CommandConflictError: errors.CommandConflictError,
    ReservedCommandError: reserved.ReservedCommandError,
    AdvancedCommandConflictError,
    ALERT_TEXT_ANIMATIONS: ['none', 'wave'],
  };
});
// advancedCommandValidation pulls in alertConfig → pool → config.
vi.mock('../../db/pool', () => ({ getPool: vi.fn(), withTransaction: vi.fn() }));

import { parseSettingsForm, parseEffectsForm, parseParamLines, advancedCommandErrorCode } from './advancedCommandForms';
import {
  AdvancedCommandConflictError, AdvancedCommandValidationError, CommandConflictError, ReservedCommandError,
} from '../../db';

describe('parseSettingsForm', () => {
  it('reads every field, treating blanks as defaults or no limit', () => {
    expect(parseSettingsForm({
      name: ' Hydrate ', trigger: ' !hydrate ', response: '', point_cost: '100', price_step: '', max_cost: '',
      global_cooldown_seconds: '30', user_cooldown_seconds: '', min_role: 'vip', live_only: 'on',
      max_uses_per_stream: '5', max_uses_per_user_per_stream: '', companion_enabled: 'on', is_enabled: 'on',
    })).toEqual({
      name: 'Hydrate', triggerString: '!hydrate', isEnabled: true, response: null, pointCost: 100, priceStep: 0,
      maxCost: null, globalCooldownSeconds: 30, userCooldownSeconds: 0, minRole: 'vip', liveOnly: true,
      maxUsesPerStream: 5, maxUsesPerUserPerStream: null, companionEnabled: true,
    });
  });

  it('falls back to everyone for an unknown role and off for missing checkboxes', () => {
    const settings = parseSettingsForm({ name: 'x', min_role: 'owner' });
    expect(settings).toMatchObject({ minRole: 'everyone', isEnabled: false, liveOnly: false, companionEnabled: false, triggerString: null });
  });

  it.each([['-5'], ['1.5'], ['abc']])('rejects a non-whole-number cost %s', (value) => {
    expect(() => parseSettingsForm({ name: 'x', point_cost: value })).toThrow(AdvancedCommandValidationError);
  });

  it('treats a repeated field as missing', () => {
    expect(parseSettingsForm({ name: ['a', 'b'] }).name).toBe('');
  });
});

describe('parseParamLines', () => {
  it('splits key=value lines, keeping = in values and skipping blanks', () => {
    expect(parseParamLines('color = red\r\n\n url=a=b ')).toEqual([{ key: 'color', value: 'red' }, { key: 'url', value: 'a=b' }]);
  });

  it('rejects a line without a key', () => {
    expect(() => parseParamLines('=red')).toThrow(AdvancedCommandValidationError);
    expect(() => parseParamLines('nokey')).toThrow(AdvancedCommandValidationError);
  });
});

describe('parseEffectsForm', () => {
  it('reads ticked videos of the streamer only, their weights, and the alert', () => {
    expect(parseEffectsForm({
      params: 'a=1', video_1: 'on', weight_1: '3', video_2: 'on', video_9: 'on',
      alert_enabled: 'on', alert_message: ' Hi {user} ', alert_duration_seconds: '2.5', alert_text_animation: 'wave',
    }, [1, 2])).toEqual({
      params: [{ key: 'a', value: '1' }],
      videos: [{ videoId: 1, weight: 3 }, { videoId: 2, weight: 1 }],
      alert: { messageTemplate: 'Hi {user}', durationMs: 2500, textAnimation: 'wave' },
    });
  });

  it('clamps the alert duration, defaults a bad animation, and omits an unticked alert', () => {
    expect(parseEffectsForm({ alert_enabled: 'on', alert_message: 'x', alert_duration_seconds: '999', alert_text_animation: 'spin' }, []).alert)
      .toEqual({ messageTemplate: 'x', durationMs: 60000, textAnimation: 'none' });
    expect(parseEffectsForm({ alert_enabled: 'on', alert_message: 'x', alert_duration_seconds: 'abc' }, []).alert?.durationMs).toBe(6000);
    expect(parseEffectsForm({ alert_enabled: 'on', alert_message: 'x', alert_duration_seconds: '' }, []).alert?.durationMs).toBe(6000);
    expect(parseEffectsForm({ alert_enabled: 'on', alert_message: 'x', alert_duration_seconds: '0' }, []).alert?.durationMs).toBe(1000);
    expect(parseEffectsForm({ alert_message: 'x' }, []).alert).toBeNull();
  });
});

describe('advancedCommandErrorCode', () => {
  it('maps expected errors to page codes', () => {
    expect(advancedCommandErrorCode(new AdvancedCommandValidationError('invalid_name', 'x'))).toBe('invalid_name');
    expect(advancedCommandErrorCode(new AdvancedCommandConflictError('trigger'))).toBe('duplicate_trigger');
    expect(advancedCommandErrorCode(new CommandConflictError(['!x']))).toBe('trigger_taken');
    expect(advancedCommandErrorCode(new ReservedCommandError('!so'))).toBe('reserved_trigger');
    expect(advancedCommandErrorCode(new Error('boom'))).toBeNull();
  });
});
