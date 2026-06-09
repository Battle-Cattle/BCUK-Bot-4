import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/users', () => ({
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
}));
vi.mock('../../db', () => ({
  findUser: vi.fn(),
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
}));
vi.mock('../../twitch/twitchChannelName', () => ({
  normalizeTwitchChannelName: vi.fn((name: string) => (name ? name.toLowerCase() : null)),
}));
vi.mock('./shared', () => ({
  trimField: (v: unknown) => (typeof v === 'string' ? v.trim() : ''),
}));
vi.mock('./adminUserMutations', () => ({
  isLockWaitTimeoutDbError: vi.fn().mockReturnValue(false),
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { findUser } from '../../db';
import { isLockWaitTimeoutDbError } from './adminUserMutations';
import { normalizeTwitchChannelName } from '../../twitch/twitchChannelName';
import {
  discordIdError,
  accessLevelError,
  parseTwitchEnabled,
  parseTwitchNameInput,
  checkManagerEditAuth,
  handleDbError,
} from './adminUserValidation';
import type { Response } from 'express';

const ACCESS_LEVEL_VALUES = [0, 1, 2, 3];

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

describe('checkManagerEditAuth', () => {
  const ADMIN_SESSION = { discordId: '100000000000000001', accessLevel: 3 };
  const MANAGER_SESSION = { discordId: '200000000000000002', accessLevel: 2 };

  beforeEach(() => {
    vi.mocked(findUser).mockResolvedValue(null);
  });

  it('returns "self_edit_forbidden" when editing own account', async () => {
    const result = await checkManagerEditAuth(
      { discordId: '100000000000000001', accessLevel: 3 },
      '100000000000000001',
      0,
    );
    expect(result).toBe('self_edit_forbidden');
  });

  it('returns null for admin editing a lower-level user', async () => {
    const result = await checkManagerEditAuth(ADMIN_SESSION, '300000000000000003', 0);
    expect(result).toBeNull();
  });

  it('returns null for admin editing a user at the same level', async () => {
    const result = await checkManagerEditAuth(ADMIN_SESSION, '300000000000000003', 3);
    expect(result).toBeNull();
  });

  it('returns "access_level_too_high" when manager tries to set level >= their own', async () => {
    const result = await checkManagerEditAuth(MANAGER_SESSION, '300000000000000003', 2);
    expect(result).toBe('access_level_too_high');
  });

  it('returns "access_level_too_high" when manager tries to set level above their own', async () => {
    const result = await checkManagerEditAuth(MANAGER_SESSION, '300000000000000003', 3);
    expect(result).toBe('access_level_too_high');
  });

  it('returns "target_above_level" when existing target user is at manager level', async () => {
    vi.mocked(findUser).mockResolvedValue({
      discord_id: '300000000000000003',
      access_level: 2,
    } as any);
    const result = await checkManagerEditAuth(MANAGER_SESSION, '300000000000000003', 1);
    expect(result).toBe('target_above_level');
  });

  it('returns null when existing target is below manager level', async () => {
    vi.mocked(findUser).mockResolvedValue({
      discord_id: '300000000000000003',
      access_level: 1,
    } as any);
    const result = await checkManagerEditAuth(MANAGER_SESSION, '300000000000000003', 1);
    expect(result).toBeNull();
  });

  it('returns null when target user does not exist yet', async () => {
    vi.mocked(findUser).mockResolvedValue(null);
    const result = await checkManagerEditAuth(MANAGER_SESSION, '300000000000000003', 1);
    expect(result).toBeNull();
  });
});

// ─── handleDbError ───────────────────────────────────────────────────────────

describe('handleDbError', () => {
  function mockRes() {
    const redirect = vi.fn();
    return { res: { redirect } as unknown as Response, redirect };
  }

  it('redirects to db_busy for a lock-wait-timeout error', () => {
    vi.mocked(isLockWaitTimeoutDbError).mockReturnValue(true);
    const { res, redirect } = mockRes();
    handleDbError(new Error('lock'), res, 'upsert_failed', 'test context');
    expect(redirect).toHaveBeenCalledWith('/admin/users?error=db_busy');
  });

  it('redirects to the failCode for other errors', () => {
    vi.mocked(isLockWaitTimeoutDbError).mockReturnValue(false);
    const { res, redirect } = mockRes();
    handleDbError(new Error('generic'), res, 'upsert_failed', 'test context');
    expect(redirect).toHaveBeenCalledWith('/admin/users?error=upsert_failed');
  });
});
