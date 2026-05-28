import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import type { SessionUser } from '../../types/express';
import {
  parsePositiveIntId,
  trimField,
  normalizeRequiredText,
  normalizeSingleTokenRequiredText,
  normalizeDiscordId,
  renderError,
} from './shared';

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

  it('accepts a single-element array', () => {
    expect(parsePositiveIntId(['7'])).toBe(7);
  });

  it('takes the first element of a multi-element array', () => {
    expect(parsePositiveIntId(['3', '9'])).toBe(3);
  });

  it('returns null for an array containing an invalid value', () => {
    expect(parsePositiveIntId(['abc'])).toBeNull();
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

describe('renderError', () => {
  function mockRes() {
    const render = vi.fn();
    const status = vi.fn().mockReturnValue({ render });
    return { res: { status } as unknown as Response, render, status };
  }

  it('calls res.status with the given status code', () => {
    const { res, status } = mockRes();
    renderError(res, 403, 'Forbidden', undefined);
    expect(status).toHaveBeenCalledWith(403);
  });

  it('renders the error view with user: null when sessionUser is undefined', () => {
    const { res, render } = mockRes();
    renderError(res, 400, 'Bad request', undefined);
    expect(render).toHaveBeenCalledWith('error', {
      message: 'Bad request',
      user: null,
      csrfToken: '',
    });
  });

  it('renders the error view with the provided sessionUser', () => {
    const { res, render } = mockRes();
    const user: SessionUser = {
      discordId: '123456789012345678',
      discordName: 'TestUser',
      discordAvatar: null,
      accessLevel: 1,
    };
    renderError(res, 500, 'Server error', user);
    expect(render).toHaveBeenCalledWith('error', {
      message: 'Server error',
      user,
      csrfToken: '',
    });
  });
});
