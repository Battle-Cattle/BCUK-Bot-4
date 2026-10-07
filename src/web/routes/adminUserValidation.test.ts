import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  findUser: vi.fn(),
  getMemberAccessLevel: vi.fn(),
  getEffectiveAccessLevelForUser: vi.fn(),
  getGuildsForMember: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
vi.mock('../../twitch/twitchChannelName', () => ({
  normalizeTwitchChannelName: vi.fn((name: string) => (name ? name.toLowerCase() : null)),
}));
vi.mock('./adminUserMutations', () => ({
  isLockWaitTimeoutDbError: vi.fn().mockReturnValue(false),
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import { AccessLevel } from '../../db';
import { normalizeTwitchChannelName } from '../../twitch/twitchChannelName';
import {
  discordIdError,
  accessLevelError,
  parseTwitchEnabled,
  parseTwitchNameInput,
  resolveGuildId,
  resolveValidDiscordId,
} from './adminUserValidation';
import type { Request, Response } from 'express';

const ACCESS_LEVEL_VALUES = [AccessLevel.USER, AccessLevel.MOD, AccessLevel.MANAGER, AccessLevel.ADMIN];

// ─── discordIdError ──────────────────────────────────────────────────────────

describe('discordIdError', () => {
  it('returns null for a valid 17-digit snowflake', () => {
    expect(discordIdError('12345678901234567')).toBeNull();
  });

  it('returns null for a valid 20-digit snowflake', () => {
    expect(discordIdError('12345678901234567890')).toBeNull();
  });

  it('returns "invalid_discord_id" for fewer than 17 digits', () => {
    expect(discordIdError('1234567890123456')).toBe('invalid_discord_id');
  });

  it('returns "invalid_discord_id" for more than 20 digits', () => {
    expect(discordIdError('123456789012345678901')).toBe('invalid_discord_id');
  });

  it('returns "invalid_discord_id" for non-numeric string', () => {
    expect(discordIdError('abcdefghijklmnopqrs')).toBe('invalid_discord_id');
  });

  it('returns "invalid_discord_id" for an empty string', () => {
    expect(discordIdError('')).toBe('invalid_discord_id');
  });
});

// ─── accessLevelError ────────────────────────────────────────────────────────

describe('accessLevelError', () => {
  it('returns null for each valid access level', () => {
    for (const level of ACCESS_LEVEL_VALUES) {
      expect(accessLevelError(String(level))).toBeNull();
    }
  });

  it('returns "invalid_access_level" for a non-numeric string', () => {
    expect(accessLevelError('admin')).toBe('invalid_access_level');
  });

  it('returns "invalid_access_level" for an empty string', () => {
    expect(accessLevelError('')).toBe('invalid_access_level');
  });

  it('returns "invalid_access_level" for a number not in the enum (e.g. 5)', () => {
    expect(accessLevelError('5')).toBe('invalid_access_level');
  });

  it('returns "invalid_access_level" for a negative number string', () => {
    expect(accessLevelError('-1')).toBe('invalid_access_level');
  });

  it('returns "invalid_access_level" for a float string', () => {
    expect(accessLevelError('1.5')).toBe('invalid_access_level');
  });
});

// ─── parseTwitchEnabled ──────────────────────────────────────────────────────

describe('parseTwitchEnabled', () => {
  it('returns true for "true"', () => {
    expect(parseTwitchEnabled('true')).toBe(true);
  });

  it('returns true for "1"', () => {
    expect(parseTwitchEnabled('1')).toBe(true);
  });

  it('returns false for "false"', () => {
    expect(parseTwitchEnabled('false')).toBe(false);
  });

  it('returns false for "0"', () => {
    expect(parseTwitchEnabled('0')).toBe(false);
  });

  it('returns null for undefined', () => {
    expect(parseTwitchEnabled(undefined)).toBeNull();
  });

  it('returns null for an arbitrary string', () => {
    expect(parseTwitchEnabled('yes')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseTwitchEnabled('')).toBeNull();
  });
});

// ─── parseTwitchNameInput ────────────────────────────────────────────────────

describe('parseTwitchNameInput', () => {
  beforeEach(() => {
    vi.mocked(normalizeTwitchChannelName).mockImplementation((name: string) =>
      name ? name.toLowerCase() : null,
    );
  });

  it('returns shouldClearTwitchName=true when clearTwitchName is "1"', () => {
    const result = parseTwitchNameInput(undefined, '1');
    expect(result.shouldClearTwitchName).toBe(true);
  });

  it('returns shouldClearTwitchName=false when clearTwitchName is not "1"', () => {
    expect(parseTwitchNameInput(undefined, '0').shouldClearTwitchName).toBe(false);
    expect(parseTwitchNameInput(undefined, undefined).shouldClearTwitchName).toBe(false);
  });

  it('returns null normalizedTwitchName when twitchName is undefined', () => {
    const result = parseTwitchNameInput(undefined, undefined);
    expect(result.normalizedTwitchName).toBeNull();
    expect(result.error).toBeNull();
  });

  it('returns null normalizedTwitchName when twitchName is empty/whitespace', () => {
    const result = parseTwitchNameInput('   ', undefined);
    expect(result.normalizedTwitchName).toBeNull();
    expect(result.error).toBeNull();
  });

  it('returns normalized name for a valid channel name', () => {
    vi.mocked(normalizeTwitchChannelName).mockReturnValue('streamer');
    const result = parseTwitchNameInput('Streamer', undefined);
    expect(result.normalizedTwitchName).toBe('streamer');
    expect(result.error).toBeNull();
  });

  it('returns error=invalid_twitch_name when normalization returns null for a non-empty name', () => {
    vi.mocked(normalizeTwitchChannelName).mockReturnValue(null);
    const result = parseTwitchNameInput('!!!invalid!!!', undefined);
    expect(result.error).toBe('invalid_twitch_name');
    expect(result.normalizedTwitchName).toBeNull();
  });

  it('does not return error when clear flag is set even with a non-empty name', () => {
    vi.mocked(normalizeTwitchChannelName).mockReturnValue(null);
    const result = parseTwitchNameInput('!!!invalid!!!', '1');
    // clearTwitchName=true bypasses the validation check
    expect(result.error).toBeNull();
    expect(result.shouldClearTwitchName).toBe(true);
  });
});

// ─── checkManagerEditAuth ────────────────────────────────────────────────────

describe('resolveGuildId', () => {
  function mockRes() {
    const redirect = vi.fn();
    return { res: { redirect } as unknown as Response, redirect };
  }

  it('returns the current guild id when one is set in the session', () => {
    const { res, redirect } = mockRes();
    const req = { session: { user: { currentGuildId: '900000000000000001' } } } as unknown as Request;
    expect(resolveGuildId(req, res)).toBe('900000000000000001');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects to /guild/select and returns null when no guild is set', () => {
    const { res, redirect } = mockRes();
    const req = { session: { user: { currentGuildId: undefined } } } as unknown as Request;
    expect(resolveGuildId(req, res)).toBeNull();
    expect(redirect).toHaveBeenCalledWith('/guild/select');
  });
});

// ─── resolveValidDiscordId ───────────────────────────────────────────────────

describe('resolveValidDiscordId', () => {
  function mockRes() {
    const redirect = vi.fn();
    return { res: { redirect } as unknown as Response, redirect };
  }

  it('returns the trimmed id for a valid snowflake', () => {
    const { res, redirect } = mockRes();
    expect(resolveValidDiscordId(res, '  12345678901234567  ')).toBe('12345678901234567');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects to /admin/users and returns null when the id is absent', () => {
    const { res, redirect } = mockRes();
    expect(resolveValidDiscordId(res, undefined)).toBeNull();
    expect(redirect).toHaveBeenCalledWith('/admin/users');
  });

  it('redirects to /admin/users and returns null for a whitespace-only id', () => {
    const { res, redirect } = mockRes();
    expect(resolveValidDiscordId(res, '   ')).toBeNull();
    expect(redirect).toHaveBeenCalledWith('/admin/users');
  });

  it('redirects to ?error=invalid_discord_id for a malformed id', () => {
    const { res, redirect } = mockRes();
    expect(resolveValidDiscordId(res, 'not-a-snowflake')).toBeNull();
    expect(redirect).toHaveBeenCalledWith('/admin/users?error=invalid_discord_id');
  });
});

// ─── checkToggleTwitchAuth ───────────────────────────────────────────────────
//
// Unlike the old resolveToggleTwitchInputs, this returns an error code (or null) directly
// instead of redirecting — callers run it inside runUserMutation's callback, atomically with
// the write it guards, so its result can't go stale against a concurrent write for the same
// user (see checkManagerEditAuth's doc comment for the same reasoning).
