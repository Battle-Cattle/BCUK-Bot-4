import { describe, it, expect, vi } from 'vitest';
import multer from 'multer';
import type { Response } from 'express';
import type { SessionUser } from '../../types/express';

vi.mock('../../db/users', () => ({ AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 } }));

vi.mock('../../db', () => {
  class ReservedCommandError extends Error {}
  class CommandConflictError extends Error {}
  return {
    getStreamerByDiscordId: vi.fn(),
    ReservedCommandError,
    CommandConflictError,
    isMysqlDuplicateEntryError: vi.fn().mockReturnValue(false),
  };
});

import { AccessLevel } from '../../db/users';
import {
  getStreamerByDiscordId,
  ReservedCommandError,
  CommandConflictError,
  isMysqlDuplicateEntryError,
} from '../../db';
import {
  parsePositiveIntId,
  trimField,
  normalizeRequiredText,
  normalizeSingleTokenRequiredText,
  normalizeDiscordId,
  renderError,
  renderView,
  filterQueryParam,
  logAndRedirectError,
  requireStreamer,
  parseWeight,
  parseRewardIdParam,
  handleReservedOrConflictCommandError,
  createMulterErrorRedirectHandler,
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

  it('throws when data contains an EJS-reserved option key', () => {
    const { res } = mockRes();
    expect(() => renderView(res, 'error', { outputFunctionName: 'x' })).toThrow(/reserved key/);
  });

  it('throws when data contains the EJS "escape" option key', () => {
    const { res } = mockRes();
    expect(() => renderView(res, 'error', { escape: (x: unknown) => String(x) })).toThrow(/reserved key/);
  });

  it('throws when data contains the deprecated EJS "scope" alias for "context"', () => {
    const { res } = mockRes();
    expect(() => renderView(res, 'error', { scope: {} })).toThrow(/reserved key/);
  });

  it('throws when data contains a "settings" key (EJS renderFile\'s Express compat bypass)', () => {
    const { res } = mockRes();
    expect(() => renderView(res, 'error', { settings: { 'view options': { outputFunctionName: 'x' } } })).toThrow(
      /reserved key/,
    );
  });

  it('throws when data contains a prototype-pollution key', () => {
    const { res } = mockRes();
    const data = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    expect(() => renderView(res, 'error', data)).toThrow(/reserved key/);
  });

  it('throws when data contains a "constructor" key', () => {
    const { res } = mockRes();
    expect(() => renderView(res, 'error', { constructor: {} })).toThrow(/reserved key/);
  });

  it('does not call res.render when data has a reserved key', () => {
    const { res, render } = mockRes();
    expect(() => renderView(res, 'error', { cache: true })).toThrow();
    expect(render).not.toHaveBeenCalled();
  });

  it('throws when data is not a plain object', () => {
    const { res } = mockRes();
    expect(() => renderView(res, 'error', [1, 2, 3] as unknown as Record<string, unknown>)).toThrow(
      /plain object/,
    );
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

describe('logAndRedirectError', () => {
  function mockRes() {
    const redirect = vi.fn();
    return { res: { redirect } as unknown as Response, redirect };
  }

  function mockLog() {
    const error = vi.fn();
    return { log: { error } as unknown as import('winston').Logger, error };
  }

  it('logs the error with the given label and forwards err unchanged', () => {
    const { res } = mockRes();
    const { log, error } = mockLog();
    const err = new Error('boom');
    logAndRedirectError({ res, log, logLabel: 'Add SFX category error:', err, basePath: '/sfx', errorCode: 'add_failed' });
    expect(error).toHaveBeenCalledWith('Add SFX category error:', err);
  });

  it('redirects to basePath with the error query param', () => {
    const { res, redirect } = mockRes();
    const { log } = mockLog();
    logAndRedirectError({ res, log, logLabel: 'Rename SFX category error:', err: new Error('x'), basePath: '/sfx', errorCode: 'update_failed' });
    expect(redirect).toHaveBeenCalledWith('/sfx?error=update_failed');
  });

  it('works with a non-Error thrown value', () => {
    const { res, redirect } = mockRes();
    const { log, error } = mockLog();
    logAndRedirectError({ res, log, logLabel: 'Remove error:', err: 'not an error object', basePath: '/counters', errorCode: 'remove_failed' });
    expect(error).toHaveBeenCalledWith('Remove error:', 'not an error object');
    expect(redirect).toHaveBeenCalledWith('/counters?error=remove_failed');
  });
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
    const result = await requireStreamer(req, res, '/channel-points?error=not_a_streamer');
    expect(result).toBe(streamer);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('redirects to the caller-supplied path and returns null when not found', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const { req, res } = makeReqRes();
    const result = await requireStreamer(req, res, '/overlay/settings?error=not_a_streamer');
    expect(result).toBeNull();
    expect(res.redirect).toHaveBeenCalledWith('/overlay/settings?error=not_a_streamer');
  });

  it("calls getStreamerByDiscordId with the session user's discordId", async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const { req, res } = makeReqRes('200000000000000002');
    await requireStreamer(req, res, '/channel-points?error=not_a_streamer');
    expect(getStreamerByDiscordId).toHaveBeenCalledWith('200000000000000002');
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

describe('handleReservedOrConflictCommandError', () => {
  function mockRes() {
    const redirect = vi.fn();
    return { res: { redirect } as unknown as Response, redirect };
  }

  const OPTIONS = { basePath: '/commands', conflictErrorCode: 'command_taken' };

  it('redirects to basePath?error=reserved_command for a ReservedCommandError and returns true', () => {
    const { res, redirect } = mockRes();
    const handled = handleReservedOrConflictCommandError(new ReservedCommandError('reserved'), res, OPTIONS);
    expect(handled).toBe(true);
    expect(redirect).toHaveBeenCalledWith('/commands?error=reserved_command');
  });

  it('redirects to basePath?error=<conflictErrorCode> for a CommandConflictError and returns true', () => {
    const { res, redirect } = mockRes();
    const handled = handleReservedOrConflictCommandError(new CommandConflictError(['conflict']), res, OPTIONS);
    expect(handled).toBe(true);
    expect(redirect).toHaveBeenCalledWith('/commands?error=command_taken');
  });

  it('redirects to basePath?error=<conflictErrorCode> for a raw MySQL duplicate-entry error and returns true', () => {
    vi.mocked(isMysqlDuplicateEntryError).mockReturnValueOnce(true);
    const { res, redirect } = mockRes();
    const handled = handleReservedOrConflictCommandError(new Error('ER_DUP_ENTRY'), res, OPTIONS);
    expect(handled).toBe(true);
    expect(redirect).toHaveBeenCalledWith('/commands?error=command_taken');
  });

  it('returns false and does not redirect for an unrelated error', () => {
    const { res, redirect } = mockRes();
    const handled = handleReservedOrConflictCommandError(new Error('boom'), res, OPTIONS);
    expect(handled).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('uses the caller-supplied basePath and conflictErrorCode', () => {
    const { res, redirect } = mockRes();
    handleReservedOrConflictCommandError(
      new CommandConflictError(['conflict']),
      res,
      { basePath: '/counters', conflictErrorCode: 'duplicate_command' },
    );
    expect(redirect).toHaveBeenCalledWith('/counters?error=duplicate_command');
  });
});

describe('createMulterErrorRedirectHandler', () => {
  function mockRes() {
    const redirect = vi.fn();
    return { res: { redirect } as unknown as Response, redirect };
  }

  function mockLog() {
    const error = vi.fn();
    return { log: { error } as unknown as import('winston').Logger, error };
  }

  it('returns false and does not redirect when there is no error', () => {
    const { log } = mockLog();
    const { res, redirect } = mockRes();
    const handler = createMulterErrorRedirectHandler('/sfx', log, 'SFX upload middleware error:');
    expect(handler(null, res)).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects oversized files to file_too_large without logging', () => {
    const { log, error } = mockLog();
    const { res, redirect } = mockRes();
    const handler = createMulterErrorRedirectHandler('/sfx', log, 'SFX upload middleware error:');
    const err = new multer.MulterError('LIMIT_FILE_SIZE', 'sound');
    expect(handler(err, res)).toBe(true);
    expect(redirect).toHaveBeenCalledWith('/sfx?error=file_too_large');
    expect(error).not.toHaveBeenCalled();
  });

  it('logs and redirects other errors to upload_failed, using the caller-supplied basePath and log label', () => {
    const { log, error } = mockLog();
    const { res, redirect } = mockRes();
    const handler = createMulterErrorRedirectHandler('/overlay/settings', log, 'Overlay upload middleware error:');
    const err = new Error('boom');
    expect(handler(err, res)).toBe(true);
    expect(error).toHaveBeenCalledWith('Overlay upload middleware error:', err);
    expect(redirect).toHaveBeenCalledWith('/overlay/settings?error=upload_failed');
  });
});
