import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import type { SessionUser } from '../../types/express';

vi.mock('../../db/users', () => ({ AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 } }));

import { AccessLevel } from '../../db/users';
import {
  parsePositiveIntId,
  trimField,
  normalizeRequiredText,
  normalizeSingleTokenRequiredText,
  normalizeDiscordId,
  renderError,
  renderView,
  filterQueryParam,
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

describe('renderView', () => {
  function mockRes() {
    const render = vi.fn();
    return { res: { render } as unknown as Response, render };
  }

  it('forwards a known view and data to res.render unchanged', () => {
    const { res, render } = mockRes();
    renderView(res, 'error', { message: 'hi' });
    expect(render).toHaveBeenCalledWith('error', { message: 'hi' });
  });

  it('throws for a view name with no matching .ejs file under views/', () => {
    const { res } = mockRes();
    expect(() => renderView(res, 'not-a-real-view')).toThrow(/unknown view/);
  });

  it('does not call res.render when the view is unknown', () => {
    const { res, render } = mockRes();
    expect(() => renderView(res, '../../etc/passwd')).toThrow();
    expect(render).not.toHaveBeenCalled();
  });
});

describe('renderError', () => {
  function mockRes() {
    const render = vi.fn();
    const status = vi.fn();
    return { res: { status, render } as unknown as Response, render, status };
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
      isOwner: false,
      accessLevel: AccessLevel.MOD,
      currentGuildId: '999000999000999000',
      guilds: [{ guildId: '999000999000999000', name: 'Test Guild' }],
    };
    renderError(res, 500, 'Server error', user);
    expect(render).toHaveBeenCalledWith('error', {
      message: 'Server error',
      user,
      csrfToken: '',
    });
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
