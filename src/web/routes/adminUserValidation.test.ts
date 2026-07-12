import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db/users', () => ({
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
vi.mock('../../db', () => ({
  findUser: vi.fn(),
  getMemberAccessLevel: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
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
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import { findUser, getMemberAccessLevel } from '../../db';
import { AccessLevel } from '../../db/users';
import { isLockWaitTimeoutDbError } from './adminUserMutations';
import { normalizeTwitchChannelName } from '../../twitch/twitchChannelName';
import {
  discordIdError,
  accessLevelError,
  parseTwitchEnabled,
  parseTwitchNameInput,
  checkManagerEditAuth,
  handleDbError,
  resolveGuildId,
  resolveValidDiscordId,
  resolveToggleTwitchInputs,
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

describe('checkManagerEditAuth', () => {
  const GUILD_ID = '900000000000000001';
  const ADMIN_SESSION = { discordId: '100000000000000001', accessLevel: AccessLevel.ADMIN, isOwner: false };
  const MANAGER_SESSION = { discordId: '200000000000000002', accessLevel: AccessLevel.MANAGER, isOwner: false };

  beforeEach(() => {
    vi.mocked(findUser).mockResolvedValue(null);
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
  });

  it('returns "self_edit_forbidden" when editing own account', async () => {
    const result = await checkManagerEditAuth(
      { discordId: '100000000000000001', accessLevel: AccessLevel.ADMIN, isOwner: false },
      '100000000000000001',
      AccessLevel.USER,
      GUILD_ID,
    );
    expect(result).toBe('self_edit_forbidden');
  });

  it('returns "target_above_level" when a non-owner edits an owner', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: '300000000000000003', is_owner: true } as any);
    const result = await checkManagerEditAuth(ADMIN_SESSION, '300000000000000003', AccessLevel.USER, GUILD_ID);
    expect(result).toBe('target_above_level');
  });

  it('returns null for admin editing a lower-level user', async () => {
    const result = await checkManagerEditAuth(ADMIN_SESSION, '300000000000000003', AccessLevel.USER, GUILD_ID);
    expect(result).toBeNull();
  });

  it('returns null for admin editing a user at the same level', async () => {
    const result = await checkManagerEditAuth(ADMIN_SESSION, '300000000000000003', AccessLevel.ADMIN, GUILD_ID);
    expect(result).toBeNull();
  });

  it('returns "access_level_too_high" when manager tries to set level >= their own', async () => {
    const result = await checkManagerEditAuth(MANAGER_SESSION, '300000000000000003', AccessLevel.MANAGER, GUILD_ID);
    expect(result).toBe('access_level_too_high');
  });

  it('returns "access_level_too_high" when manager tries to set level above their own', async () => {
    const result = await checkManagerEditAuth(MANAGER_SESSION, '300000000000000003', AccessLevel.ADMIN, GUILD_ID);
    expect(result).toBe('access_level_too_high');
  });

  it('returns "target_above_level" when the target is already at manager level in this guild', async () => {
    vi.mocked(getMemberAccessLevel).mockResolvedValue(AccessLevel.MANAGER);
    const result = await checkManagerEditAuth(MANAGER_SESSION, '300000000000000003', AccessLevel.MOD, GUILD_ID);
    expect(result).toBe('target_above_level');
    expect(vi.mocked(getMemberAccessLevel)).toHaveBeenCalledWith(GUILD_ID, '300000000000000003');
  });

  it('returns null when the target is below manager level in this guild', async () => {
    vi.mocked(getMemberAccessLevel).mockResolvedValue(AccessLevel.MOD);
    const result = await checkManagerEditAuth(MANAGER_SESSION, '300000000000000003', AccessLevel.MOD, GUILD_ID);
    expect(result).toBeNull();
  });

  it('returns null when target has no membership in this guild yet', async () => {
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
    const result = await checkManagerEditAuth(MANAGER_SESSION, '300000000000000003', AccessLevel.MOD, GUILD_ID);
    expect(result).toBeNull();
  });
});

// ─── resolveGuildId ──────────────────────────────────────────────────────────

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

// ─── resolveToggleTwitchInputs ───────────────────────────────────────────────

describe('resolveToggleTwitchInputs', () => {
  const GUILD_ID = '900000000000000001';
  const TARGET_ID = '300000000000000001';
  const ADMIN_USER = { accessLevel: AccessLevel.ADMIN, isOwner: false };
  const MANAGER_USER = { accessLevel: AccessLevel.MANAGER, isOwner: false };
  const OWNER_USER = { accessLevel: AccessLevel.ADMIN, isOwner: true };

  function mockRes() {
    const redirect = vi.fn();
    return { res: { redirect } as unknown as Response, redirect };
  }

  beforeEach(() => {
    vi.mocked(getMemberAccessLevel).mockResolvedValue(0);
    vi.mocked(findUser).mockResolvedValue(null);
  });

  it('returns true when enabled flag is "true" and target is a guild member', async () => {
    const { res, redirect } = mockRes();
    const result = await resolveToggleTwitchInputs(res, ADMIN_USER, GUILD_ID, TARGET_ID, 'true');
    expect(result).toBe(true);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('returns false when enabled flag is "false" and target is a guild member', async () => {
    const { res, redirect } = mockRes();
    const result = await resolveToggleTwitchInputs(res, ADMIN_USER, GUILD_ID, TARGET_ID, 'false');
    expect(result).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects ?error=invalid_twitch_state and returns null for an unrecognised flag', async () => {
    const { res, redirect } = mockRes();
    const result = await resolveToggleTwitchInputs(res, ADMIN_USER, GUILD_ID, TARGET_ID, 'maybe');
    expect(result).toBeNull();
    expect(redirect).toHaveBeenCalledWith('/admin/users?error=invalid_twitch_state');
  });

  it('redirects ?error=target_above_level and returns null when target is not a guild member', async () => {
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
    const { res, redirect } = mockRes();
    const result = await resolveToggleTwitchInputs(res, ADMIN_USER, GUILD_ID, TARGET_ID, 'true');
    expect(result).toBeNull();
    expect(redirect).toHaveBeenCalledWith('/admin/users?error=target_above_level');
  });

  it('redirects ?error=target_above_level when a non-admin actor targets a user at their own level', async () => {
    vi.mocked(getMemberAccessLevel).mockResolvedValue(AccessLevel.MANAGER);
    const { res, redirect } = mockRes();
    const result = await resolveToggleTwitchInputs(res, MANAGER_USER, GUILD_ID, TARGET_ID, 'true');
    expect(result).toBeNull();
    expect(redirect).toHaveBeenCalledWith('/admin/users?error=target_above_level');
  });

  it('allows an admin actor to toggle a target at any level', async () => {
    vi.mocked(getMemberAccessLevel).mockResolvedValue(AccessLevel.ADMIN);
    const { res, redirect } = mockRes();
    const result = await resolveToggleTwitchInputs(res, ADMIN_USER, GUILD_ID, TARGET_ID, 'true');
    expect(result).toBe(true);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects ?error=target_above_level when a non-owner admin targets a bot owner', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: TARGET_ID, is_owner: true } as any);
    const { res, redirect } = mockRes();
    const result = await resolveToggleTwitchInputs(res, ADMIN_USER, GUILD_ID, TARGET_ID, 'true');
    expect(result).toBeNull();
    expect(redirect).toHaveBeenCalledWith('/admin/users?error=target_above_level');
  });

  it('allows an owner to toggle another bot owner', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: TARGET_ID, is_owner: true } as any);
    const { res, redirect } = mockRes();
    const result = await resolveToggleTwitchInputs(res, OWNER_USER, GUILD_ID, TARGET_ID, 'true');
    expect(result).toBe(true);
    expect(redirect).not.toHaveBeenCalled();
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
