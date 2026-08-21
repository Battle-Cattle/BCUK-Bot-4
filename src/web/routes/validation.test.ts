import { describe, it, expect } from 'vitest';
import {
  parsePositiveIntId,
  parseCheckboxField,
  trimField,
  normalizeRequiredText,
  normalizeSingleTokenRequiredText,
  normalizeDiscordId,
  filterQueryParam,
  parseWeight,
  parseRewardIdParam,
} from './validation';

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

describe('parsePositiveIntId', () => {
  it('returns null for undefined', () => {
    expect(parsePositiveIntId(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parsePositiveIntId('')).toBeNull();
  });

  it('returns null for a non-numeric string', () => {
    expect(parsePositiveIntId('abc')).toBeNull();
  });

  it('returns null for zero', () => {
    expect(parsePositiveIntId('0')).toBeNull();
  });

  it('returns null for a negative number string', () => {
    expect(parsePositiveIntId('-1')).toBeNull();
  });

  it('returns the parsed number for a valid positive integer string', () => {
    expect(parsePositiveIntId('42')).toBe(42);
  });

  it('returns null for a single-element array (repeated field)', () => {
    expect(parsePositiveIntId(['7'])).toBeNull();
  });

  it('returns null for a multi-element array (repeated field)', () => {
    expect(parsePositiveIntId(['3', '9'])).toBeNull();
  });
});

describe('trimField', () => {
  it('returns empty string for undefined', () => {
    expect(trimField(undefined)).toBe('');
  });

  it('trims leading and trailing whitespace', () => {
    expect(trimField('  hello  ')).toBe('hello');
  });

  it('returns the value unchanged when already trimmed', () => {
    expect(trimField('hello')).toBe('hello');
  });

  it('returns empty string for a whitespace-only string', () => {
    expect(trimField('   ')).toBe('');
  });

  it('returns empty string for an array (Express duplicate-param value)', () => {
    expect(trimField(['a', 'b'])).toBe('');
  });

  it('returns empty string for null', () => {
    expect(trimField(null)).toBe('');
  });
});

describe('normalizeRequiredText', () => {
  it('returns null for undefined', () => {
    expect(normalizeRequiredText(undefined)).toBeNull();
  });

  it('returns null for a non-string (number)', () => {
    expect(normalizeRequiredText(42 as unknown as string)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(normalizeRequiredText('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(normalizeRequiredText('   ')).toBeNull();
  });

  it('trims and returns a valid string', () => {
    expect(normalizeRequiredText('  hello  ')).toBe('hello');
  });

  it('returns the value unchanged when already trimmed', () => {
    expect(normalizeRequiredText('hello world')).toBe('hello world');
  });
});

describe('normalizeSingleTokenRequiredText', () => {
  it('returns null for undefined', () => {
    expect(normalizeSingleTokenRequiredText(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(normalizeSingleTokenRequiredText('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(normalizeSingleTokenRequiredText('   ')).toBeNull();
  });

  it('returns null for a string with internal whitespace', () => {
    expect(normalizeSingleTokenRequiredText('hello world')).toBeNull();
  });

  it('returns null for a string with leading/trailing whitespace that reveals a space', () => {
    expect(normalizeSingleTokenRequiredText('  a b  ')).toBeNull();
  });

  it('lowercases and returns a single-token string', () => {
    expect(normalizeSingleTokenRequiredText('!Clap')).toBe('!clap');
  });

  it('trims surrounding whitespace before checking for tokens', () => {
    expect(normalizeSingleTokenRequiredText('  !cmd  ')).toBe('!cmd');
  });

  it('returns null for a trigger containing angle brackets', () => {
    expect(normalizeSingleTokenRequiredText('!<test>')).toBeNull();
  });

  it('returns null for a trigger containing an ampersand', () => {
    expect(normalizeSingleTokenRequiredText('!test&me')).toBeNull();
  });

  it('returns null for a trigger with only a prefix character', () => {
    expect(normalizeSingleTokenRequiredText('!')).toBeNull();
  });

  it('allows valid triggers with hyphens and underscores', () => {
    expect(normalizeSingleTokenRequiredText('!my-cmd_1')).toBe('!my-cmd_1');
  });

  it('returns null for a trigger containing quote characters', () => {
    expect(normalizeSingleTokenRequiredText("!it's")).toBeNull();
    expect(normalizeSingleTokenRequiredText('!say"hi"')).toBeNull();
  });
});

describe('normalizeDiscordId', () => {
  it('returns null for undefined', () => {
    expect(normalizeDiscordId(undefined)).toBeNull();
  });

  it('returns null for a non-string', () => {
    expect(normalizeDiscordId(123 as unknown as string)).toBeNull();
  });

  it('returns null for a string that is too short (< 17 digits)', () => {
    expect(normalizeDiscordId('1234567890123456')).toBeNull();
  });

  it('returns null for a string that is too long (> 20 digits)', () => {
    expect(normalizeDiscordId('123456789012345678901')).toBeNull();
  });

  it('returns null for a non-numeric string', () => {
    expect(normalizeDiscordId('abcdefghijklmnopqrs')).toBeNull();
  });

  it('returns the trimmed id for a valid 17-digit ID', () => {
    expect(normalizeDiscordId('12345678901234567')).toBe('12345678901234567');
  });

  it('returns the trimmed id for a valid 20-digit ID', () => {
    expect(normalizeDiscordId('12345678901234567890')).toBe('12345678901234567890');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(normalizeDiscordId('  12345678901234567  ')).toBe('12345678901234567');
  });
});

describe('filterQueryParam', () => {
  const ALLOWED = new Set(['known_error', 'another_error']);

  it('returns the value when it is in the allowed set', () => {
    expect(filterQueryParam('known_error', ALLOWED)).toBe('known_error');
  });

  it('returns null for a string not in the allowed set', () => {
    expect(filterQueryParam('<script>alert(1)</script>', ALLOWED)).toBeNull();
  });

  it('returns null for an array (Express duplicate-param value)', () => {
    expect(filterQueryParam(['known_error', 'x'], ALLOWED)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(filterQueryParam(undefined, ALLOWED)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(filterQueryParam('', ALLOWED)).toBeNull();
  });

  it('returns null when the allowed set is empty', () => {
    expect(filterQueryParam('known_error', new Set())).toBeNull();
  });
});

describe('parseWeight', () => {
  it('returns null for undefined', () => {
    expect(parseWeight(undefined)).toBeNull();
  });

  it('returns null for a non-numeric string', () => {
    expect(parseWeight('abc')).toBeNull();
  });

  it('returns null for zero', () => {
    expect(parseWeight('0')).toBeNull();
  });

  it('returns null for a negative number', () => {
    expect(parseWeight('-5')).toBeNull();
  });

  it('returns the parsed integer for a valid positive number', () => {
    expect(parseWeight('10')).toBe(10);
  });

  it('floors a float string', () => {
    expect(parseWeight('3.9')).toBe(3);
  });

  it('floors a float close to the next integer', () => {
    expect(parseWeight('2.99')).toBe(2);
  });

  it('returns null for an array (repeated field)', () => {
    expect(parseWeight(['7', '99'])).toBeNull();
  });

  it('returns null for an array with a non-numeric first element', () => {
    expect(parseWeight(['abc'])).toBeNull();
  });

  it('returns null for an empty array', () => {
    expect(parseWeight([])).toBeNull();
  });

  it('returns null for Infinity (not finite)', () => {
    expect(parseWeight('Infinity')).toBeNull();
  });

  it('returns null for a single-element array (repeated field)', () => {
    expect(parseWeight(['7'])).toBeNull();
  });
});

describe('parseRewardIdParam', () => {
  const VALID_REWARD_ID = '12345678-1234-1234-8234-123456789abc';

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
