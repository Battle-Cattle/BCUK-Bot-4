import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  findUser: vi.fn(),
  getMemberAccessLevel: vi.fn(),
  getEffectiveAccessLevelForUser: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
vi.mock('../../twitch/twitchChannelName', () => ({
  normalizeTwitchChannelName: vi.fn((name: string) => (name ? name.toLowerCase() : null)),
}));
vi.mock('./shared', () => ({
  trimField: (v: unknown) => (typeof v === 'string' ? v.trim() : ''),
  normalizeDiscordId: (v: unknown) => (typeof v === 'string' && /^\d{17,20}$/.test(v.trim()) ? v.trim() : null),
}));
vi.mock('./adminUserMutations', () => ({
  isLockWaitTimeoutDbError: vi.fn().mockReturnValue(false),
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import { findUser, getMemberAccessLevel, getEffectiveAccessLevelForUser } from '../../db';
import { AccessLevel } from '../../db';
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
  checkToggleTwitchAuth,
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
  const ADMIN_ID = '100000000000000001';
  const MANAGER_ID = '200000000000000002';
  const TARGET_ID = '300000000000000003';
  const ADMIN_SESSION = { discordId: ADMIN_ID };
  const MANAGER_SESSION = { discordId: MANAGER_ID };

  // Sets up the acting user's fresh (re-read, not session-cached) access level and owner flag —
  // see checkManagerEditAuth's doc comment on why these are resolved from the DB rather than
  // trusted from the caller's sessionUser argument.
  function mockActingUser(accessLevel: number, isOwner = false): void {
    vi.mocked(getEffectiveAccessLevelForUser).mockResolvedValue(accessLevel);
    vi.mocked(findUser).mockImplementation(async (id: string) =>
      ({ discord_id: id, is_owner: id === ADMIN_ID || id === MANAGER_ID ? isOwner : false }) as any,
    );
  }

  beforeEach(() => {
    vi.mocked(findUser).mockResolvedValue(null);
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
    vi.mocked(getEffectiveAccessLevelForUser).mockResolvedValue(AccessLevel.USER);
  });

  it('returns "self_edit_forbidden" when editing own account', async () => {
    const result = await checkManagerEditAuth({ discordId: ADMIN_ID }, ADMIN_ID, AccessLevel.USER, GUILD_ID);
    expect(result).toBe('self_edit_forbidden');
  });

  it('returns "target_above_level" when a non-owner edits an owner', async () => {
    mockActingUser(AccessLevel.ADMIN);
    vi.mocked(findUser).mockImplementation(async (id: string) =>
      (id === TARGET_ID ? { discord_id: TARGET_ID, is_owner: true } : { discord_id: id, is_owner: false }) as any,
    );
    const result = await checkManagerEditAuth(ADMIN_SESSION, TARGET_ID, AccessLevel.USER, GUILD_ID);
    expect(result).toBe('target_above_level');
  });

  it('returns null for admin editing a lower-level user', async () => {
    mockActingUser(AccessLevel.ADMIN);
    const result = await checkManagerEditAuth(ADMIN_SESSION, TARGET_ID, AccessLevel.USER, GUILD_ID);
    expect(result).toBeNull();
  });

  it('returns null for admin editing a user at the same level', async () => {
    mockActingUser(AccessLevel.ADMIN);
    const result = await checkManagerEditAuth(ADMIN_SESSION, TARGET_ID, AccessLevel.ADMIN, GUILD_ID);
    expect(result).toBeNull();
  });

  it('returns "access_level_too_high" when manager tries to set level >= their own', async () => {
    mockActingUser(AccessLevel.MANAGER);
    const result = await checkManagerEditAuth(MANAGER_SESSION, TARGET_ID, AccessLevel.MANAGER, GUILD_ID);
    expect(result).toBe('access_level_too_high');
  });

  it('returns "access_level_too_high" when manager tries to set level above their own', async () => {
    mockActingUser(AccessLevel.MANAGER);
    const result = await checkManagerEditAuth(MANAGER_SESSION, TARGET_ID, AccessLevel.ADMIN, GUILD_ID);
    expect(result).toBe('access_level_too_high');
  });

  it('returns "target_above_level" when the target is already at manager level in this guild', async () => {
    mockActingUser(AccessLevel.MANAGER);
    vi.mocked(getMemberAccessLevel).mockResolvedValue(AccessLevel.MANAGER);
    const result = await checkManagerEditAuth(MANAGER_SESSION, TARGET_ID, AccessLevel.MOD, GUILD_ID);
    expect(result).toBe('target_above_level');
    expect(vi.mocked(getMemberAccessLevel)).toHaveBeenCalledWith(GUILD_ID, TARGET_ID);
  });

  it('returns null when the target is below manager level in this guild', async () => {
    mockActingUser(AccessLevel.MANAGER);
    vi.mocked(getMemberAccessLevel).mockResolvedValue(AccessLevel.MOD);
    const result = await checkManagerEditAuth(MANAGER_SESSION, TARGET_ID, AccessLevel.MOD, GUILD_ID);
    expect(result).toBeNull();
  });

  it('returns null when target has no membership in this guild yet', async () => {
    mockActingUser(AccessLevel.MANAGER);
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
    const result = await checkManagerEditAuth(MANAGER_SESSION, TARGET_ID, AccessLevel.MOD, GUILD_ID);
    expect(result).toBeNull();
  });

  it('re-reads the acting user\'s access level from the DB rather than trusting a stale value passed in', async () => {
    // Regression coverage for the actor-side TOCTOU: even if a caller's sessionUser object still
    // carries an old, higher access level, the DB's current (lower) level governs the decision.
    mockActingUser(AccessLevel.MOD);
    const result = await checkManagerEditAuth(MANAGER_SESSION, TARGET_ID, AccessLevel.MANAGER, GUILD_ID);
    expect(result).toBe('access_level_too_high');
    expect(vi.mocked(getEffectiveAccessLevelForUser)).toHaveBeenCalledWith(GUILD_ID, expect.objectContaining({ discord_id: MANAGER_ID }));
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

// ─── checkToggleTwitchAuth ───────────────────────────────────────────────────
//
// Unlike the old resolveToggleTwitchInputs, this returns an error code (or null) directly
// instead of redirecting — callers run it inside runUserMutation's callback, atomically with
// the write it guards, so its result can't go stale against a concurrent write for the same
// user (see checkManagerEditAuth's doc comment for the same reasoning).

describe('checkToggleTwitchAuth', () => {
  const GUILD_ID = '900000000000000001';
  const ACTOR_ID = '100000000000000001';
  const TARGET_ID = '300000000000000001';
  const ADMIN_SESSION = { discordId: ACTOR_ID };
  const MANAGER_SESSION = { discordId: ACTOR_ID };

  // See checkManagerEditAuth.test's mockActingUser — same reasoning: the actor's access level
  // and owner flag are re-read from the DB inside the function, not trusted from the caller.
  function mockActingUser(accessLevel: number, isOwner = false): void {
    vi.mocked(getEffectiveAccessLevelForUser).mockResolvedValue(accessLevel);
    vi.mocked(findUser).mockImplementation(async (id: string) =>
      ({ discord_id: id, is_owner: id === ACTOR_ID ? isOwner : false }) as any,
    );
  }

  beforeEach(() => {
    vi.mocked(getMemberAccessLevel).mockResolvedValue(0);
    vi.mocked(findUser).mockResolvedValue(null);
    vi.mocked(getEffectiveAccessLevelForUser).mockResolvedValue(AccessLevel.USER);
  });

  it('returns null when the actor is an admin and the target is a guild member', async () => {
    mockActingUser(AccessLevel.ADMIN);
    expect(await checkToggleTwitchAuth(ADMIN_SESSION, GUILD_ID, TARGET_ID)).toBeNull();
  });

  it('returns target_above_level when target is not a guild member', async () => {
    mockActingUser(AccessLevel.ADMIN);
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
    expect(await checkToggleTwitchAuth(ADMIN_SESSION, GUILD_ID, TARGET_ID)).toBe('target_above_level');
  });

  it('returns target_above_level when a non-admin actor targets a user at their own level', async () => {
    mockActingUser(AccessLevel.MANAGER);
    vi.mocked(getMemberAccessLevel).mockResolvedValue(AccessLevel.MANAGER);
    expect(await checkToggleTwitchAuth(MANAGER_SESSION, GUILD_ID, TARGET_ID)).toBe('target_above_level');
  });

  it('allows an admin actor to toggle a target at any level', async () => {
    mockActingUser(AccessLevel.ADMIN);
    vi.mocked(getMemberAccessLevel).mockResolvedValue(AccessLevel.ADMIN);
    expect(await checkToggleTwitchAuth(ADMIN_SESSION, GUILD_ID, TARGET_ID)).toBeNull();
  });

  it('returns target_above_level when a non-owner admin targets a bot owner', async () => {
    mockActingUser(AccessLevel.ADMIN);
    vi.mocked(findUser).mockImplementation(async (id: string) =>
      (id === TARGET_ID ? { discord_id: TARGET_ID, is_owner: true } : { discord_id: id, is_owner: false }) as any,
    );
    expect(await checkToggleTwitchAuth(ADMIN_SESSION, GUILD_ID, TARGET_ID)).toBe('target_above_level');
  });

  it('allows an owner to toggle another bot owner', async () => {
    mockActingUser(AccessLevel.ADMIN, true);
    vi.mocked(findUser).mockImplementation(async (id: string) =>
      ({ discord_id: id, is_owner: true }) as any,
    );
    expect(await checkToggleTwitchAuth(ADMIN_SESSION, GUILD_ID, TARGET_ID)).toBeNull();
  });

  it('re-reads the acting user\'s access level from the DB rather than trusting a stale value passed in', async () => {
    mockActingUser(AccessLevel.MOD);
    vi.mocked(getMemberAccessLevel).mockResolvedValue(AccessLevel.MANAGER);
    const result = await checkToggleTwitchAuth(MANAGER_SESSION, GUILD_ID, TARGET_ID);
    expect(result).toBe('target_above_level');
    expect(vi.mocked(getEffectiveAccessLevelForUser)).toHaveBeenCalledWith(GUILD_ID, expect.objectContaining({ discord_id: ACTOR_ID }));
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
