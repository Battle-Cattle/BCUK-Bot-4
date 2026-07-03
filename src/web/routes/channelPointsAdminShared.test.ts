import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({ getStreamerByDiscordId: vi.fn() }));

import { getStreamerByDiscordId } from '../../db';
import {
  requireStreamer, parsePositiveIntField, parseNonNegativeNumberField, parsePositiveNumberField,
  parseCheckboxField, parseHexColorField, parseRewardIdParam, parseRewardFields,
} from './channelPointsAdminShared';

const VALID_REWARD_ID = '12345678-1234-1234-8234-123456789abc';
const VALID_REWARD_FORM = { title: 'Cool Reward', cost: '200', prompt: '', background_color: '' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireStreamer', () => {
  function makeReqRes(discordId = '123') {
    const req = { session: { user: { discordId } } } as any;
    const res = { redirect: vi.fn() } as any;
    return { req, res };
  }

  it('returns the streamer when found', async () => {
    const streamer = { id: 1 };
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(streamer as any);
    const { req, res } = makeReqRes();
    const result = await requireStreamer(req, res);
    expect(result).toBe(streamer);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('redirects to /channel-points?error=not_a_streamer and returns null when not found', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const { req, res } = makeReqRes();
    const result = await requireStreamer(req, res);
    expect(result).toBeNull();
    expect(res.redirect).toHaveBeenCalledWith('/channel-points?error=not_a_streamer');
  });
});

describe('parsePositiveIntField', () => {
  it('accepts a positive integer string', () => {
    expect(parsePositiveIntField('200')).toBe(200);
  });

  it('rejects an array (repeated field)', () => {
    expect(parsePositiveIntField(['1', '2'])).toBeNull();
  });

  it('rejects zero', () => {
    expect(parsePositiveIntField('0')).toBeNull();
  });

  it('rejects non-numeric input', () => {
    expect(parsePositiveIntField('abc')).toBeNull();
  });

  it('rejects a decimal', () => {
    expect(parsePositiveIntField('1.5')).toBeNull();
  });

  it('rejects undefined', () => {
    expect(parsePositiveIntField(undefined)).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(parsePositiveIntField('')).toBeNull();
  });
});

describe('parseNonNegativeNumberField', () => {
  it('accepts zero', () => {
    expect(parseNonNegativeNumberField('0')).toBe(0);
  });

  it('accepts a positive decimal', () => {
    expect(parseNonNegativeNumberField('4.5')).toBe(4.5);
  });

  it('rejects a negative number', () => {
    expect(parseNonNegativeNumberField('-1')).toBeNull();
  });

  it('rejects an array (repeated field)', () => {
    expect(parseNonNegativeNumberField(['1', '2'])).toBeNull();
  });

  it('rejects undefined', () => {
    expect(parseNonNegativeNumberField(undefined)).toBeNull();
  });

  it('rejects an empty string instead of silently coercing to 0', () => {
    expect(parseNonNegativeNumberField('')).toBeNull();
  });

  it('rejects a whitespace-only string instead of silently coercing to 0', () => {
    expect(parseNonNegativeNumberField('   ')).toBeNull();
  });
});

describe('parsePositiveNumberField', () => {
  it('accepts a positive decimal', () => {
    expect(parsePositiveNumberField('1.5')).toBe(1.5);
  });

  it('rejects zero', () => {
    expect(parsePositiveNumberField('0')).toBeNull();
  });

  it('rejects a negative number', () => {
    expect(parsePositiveNumberField('-1')).toBeNull();
  });

  it('rejects an array (repeated field)', () => {
    expect(parsePositiveNumberField(['1', '2'])).toBeNull();
  });

  it('rejects undefined', () => {
    expect(parsePositiveNumberField(undefined)).toBeNull();
  });

  it('rejects an empty string instead of silently coercing to 0', () => {
    expect(parsePositiveNumberField('')).toBeNull();
  });

  it('rejects a whitespace-only string instead of silently coercing to 0', () => {
    expect(parsePositiveNumberField('   ')).toBeNull();
  });
});

describe('parseCheckboxField', () => {
  it('returns true when the value is "on"', () => {
    expect(parseCheckboxField('on')).toBe(true);
  });

  it('returns false when undefined (checkbox unchecked)', () => {
    expect(parseCheckboxField(undefined)).toBe(false);
  });

  it('returns false for an array (repeated field)', () => {
    expect(parseCheckboxField(['on', 'on'])).toBe(false);
  });

  it('returns false for any other string value', () => {
    expect(parseCheckboxField('off')).toBe(false);
  });
});

describe('parseHexColorField', () => {
  it('accepts a valid 6-digit hex color', () => {
    expect(parseHexColorField('#00E5CB')).toBe('#00E5CB');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(parseHexColorField('  #00e5cb  ')).toBe('#00e5cb');
  });

  it('returns undefined for a blank value (no preference)', () => {
    expect(parseHexColorField('')).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(parseHexColorField(undefined)).toBeUndefined();
  });

  it('returns null for an array (repeated field)', () => {
    expect(parseHexColorField(['#000000', '#111111'])).toBeNull();
  });

  it('returns null for a malformed color', () => {
    expect(parseHexColorField('not-a-color')).toBeNull();
  });

  it('returns null for a hex string missing the leading #', () => {
    expect(parseHexColorField('00E5CB')).toBeNull();
  });
});

describe('parseRewardIdParam', () => {
  it('accepts a valid UUID', () => {
    expect(parseRewardIdParam(VALID_REWARD_ID)).toBe(VALID_REWARD_ID);
  });

  it('rejects an array (repeated param)', () => {
    expect(parseRewardIdParam([VALID_REWARD_ID, VALID_REWARD_ID])).toBeNull();
  });

  it('rejects a malformed string', () => {
    expect(parseRewardIdParam('not-a-uuid')).toBeNull();
  });
});

describe('parseRewardFields', () => {
  it('accepts a minimal valid form and defaults optional fields', () => {
    const result = parseRewardFields(VALID_REWARD_FORM);
    expect(result).toEqual({
      title: 'Cool Reward',
      cost: 200,
      prompt: undefined,
      is_enabled: false,
      background_color: undefined,
      is_user_input_required: false,
      is_max_per_stream_enabled: false,
      max_per_stream: undefined,
      is_max_per_user_per_stream_enabled: false,
      max_per_user_per_stream: undefined,
      is_global_cooldown_enabled: false,
      global_cooldown_seconds: undefined,
      should_redemptions_skip_request_queue: false,
    });
  });

  it('rejects a blank title', () => {
    expect(parseRewardFields({ ...VALID_REWARD_FORM, title: '  ' })).toBeNull();
  });

  it('rejects a title over 45 characters', () => {
    expect(parseRewardFields({ ...VALID_REWARD_FORM, title: 'x'.repeat(46) })).toBeNull();
  });

  it('rejects an invalid cost', () => {
    expect(parseRewardFields({ ...VALID_REWARD_FORM, cost: '0' })).toBeNull();
  });

  it('rejects a prompt over 200 characters', () => {
    expect(parseRewardFields({ ...VALID_REWARD_FORM, prompt: 'x'.repeat(201) })).toBeNull();
  });

  it('rejects user-input-required with a blank prompt', () => {
    expect(parseRewardFields({ ...VALID_REWARD_FORM, is_user_input_required: 'on', prompt: '' })).toBeNull();
  });

  it('accepts user-input-required with a non-blank prompt', () => {
    const result = parseRewardFields({ ...VALID_REWARD_FORM, is_user_input_required: 'on', prompt: 'Say something' });
    expect(result).not.toBeNull();
    expect(result?.is_user_input_required).toBe(true);
    expect(result?.prompt).toBe('Say something');
  });

  it('rejects a malformed background color', () => {
    expect(parseRewardFields({ ...VALID_REWARD_FORM, background_color: 'not-a-color' })).toBeNull();
  });

  it('rejects a per-stream limit enabled without a value', () => {
    expect(parseRewardFields({ ...VALID_REWARD_FORM, is_max_per_stream_enabled: 'on', max_per_stream: '' })).toBeNull();
  });

  it('accepts a per-stream limit enabled with a value', () => {
    const result = parseRewardFields({ ...VALID_REWARD_FORM, is_max_per_stream_enabled: 'on', max_per_stream: '3' });
    expect(result?.is_max_per_stream_enabled).toBe(true);
    expect(result?.max_per_stream).toBe(3);
  });

  it('rejects a per-user-per-stream limit enabled without a value', () => {
    expect(parseRewardFields({ ...VALID_REWARD_FORM, is_max_per_user_per_stream_enabled: 'on', max_per_user_per_stream: '' })).toBeNull();
  });

  it('rejects a global cooldown enabled without a value', () => {
    expect(parseRewardFields({ ...VALID_REWARD_FORM, is_global_cooldown_enabled: 'on', global_cooldown_seconds: '' })).toBeNull();
  });

  it('accepts a global cooldown enabled with a value', () => {
    const result = parseRewardFields({ ...VALID_REWARD_FORM, is_global_cooldown_enabled: 'on', global_cooldown_seconds: '60' });
    expect(result?.is_global_cooldown_enabled).toBe(true);
    expect(result?.global_cooldown_seconds).toBe(60);
  });
});
