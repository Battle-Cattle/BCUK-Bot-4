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

import { findUser, getMemberAccessLevel, getEffectiveAccessLevelForUser, getGuildsForMember } from '../../db';
import { AccessLevel } from '../../db';
import {
  checkManagerEditAuth,
  checkRemoveAuth,
  checkToggleTwitchAuth,
  actorOutranksTargetInAllGuilds,
  canEditGlobalUserFields,
} from './adminUserAuth';

// ─── discordIdError ──────────────────────────────────────────────────────────

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

// ─── checkRemoveAuth ─────────────────────────────────────────────────────────

describe('checkRemoveAuth', () => {
  const GUILD_ID = '900000000000000001';
  const ADMIN_ID = '100000000000000001';
  const ADMIN_SESSION = { discordId: ADMIN_ID };

  function mockActingUser(accessLevel: number): void {
    vi.mocked(getEffectiveAccessLevelForUser).mockResolvedValue(accessLevel);
    vi.mocked(findUser).mockResolvedValue({ discord_id: ADMIN_ID, is_owner: false } as any);
  }

  beforeEach(() => {
    vi.mocked(findUser).mockResolvedValue(null);
    vi.mocked(getEffectiveAccessLevelForUser).mockResolvedValue(AccessLevel.USER);
  });

  it('returns null when the actor is currently an Admin', async () => {
    mockActingUser(AccessLevel.ADMIN);
    expect(await checkRemoveAuth(ADMIN_SESSION, GUILD_ID)).toBeNull();
  });

  it('returns "target_above_level" when the actor is no longer an Admin', async () => {
    mockActingUser(AccessLevel.MANAGER);
    expect(await checkRemoveAuth(ADMIN_SESSION, GUILD_ID)).toBe('target_above_level');
  });

  it('re-reads the acting user\'s access level from the DB rather than trusting a stale value passed in', async () => {
    // Regression coverage for the actor-side TOCTOU: requireAdmin's session check happens before
    // the operation is queued, so a demotion landing in between must still be caught here.
    mockActingUser(AccessLevel.USER);
    const result = await checkRemoveAuth(ADMIN_SESSION, GUILD_ID);
    expect(result).toBe('target_above_level');
    expect(vi.mocked(getEffectiveAccessLevelForUser)).toHaveBeenCalledWith(GUILD_ID, expect.objectContaining({ discord_id: ADMIN_ID }));
  });

  it('treats a missing actor user row as User level (denies)', async () => {
    vi.mocked(findUser).mockResolvedValue(null);
    expect(await checkRemoveAuth(ADMIN_SESSION, GUILD_ID)).toBe('target_above_level');
    expect(vi.mocked(getEffectiveAccessLevelForUser)).not.toHaveBeenCalled();
  });
});

// ─── resolveGuildId ──────────────────────────────────────────────────────────

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
    vi.mocked(getGuildsForMember).mockResolvedValue([]);
  });

  it('returns target_above_level when a non-owner admin does not outrank the target in another of their guilds', async () => {
    mockActingUser(AccessLevel.ADMIN);
    vi.mocked(getGuildsForMember).mockImplementation(async (id: string) =>
      id === TARGET_ID
        ? [{ guild_id: GUILD_ID, name: 'a', voice_channel_id: null, access_level: 0 }, { guild_id: '900000000000000002', name: 'b', voice_channel_id: null, access_level: 0 }]
        : [{ guild_id: GUILD_ID, name: 'a', voice_channel_id: null, access_level: AccessLevel.ADMIN }],
    );
    expect(await checkToggleTwitchAuth(ADMIN_SESSION, GUILD_ID, TARGET_ID)).toBe('target_above_level');
  });

  it('lets an owner toggle a target regardless of the target\'s other guilds', async () => {
    mockActingUser(AccessLevel.ADMIN, true);
    vi.mocked(getGuildsForMember).mockImplementation(async (id: string) =>
      id === TARGET_ID ? [{ guild_id: '900000000000000002', name: 'b', voice_channel_id: null, access_level: AccessLevel.ADMIN }] : [],
    );
    expect(await checkToggleTwitchAuth(ADMIN_SESSION, GUILD_ID, TARGET_ID)).toBeNull();
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

// ─── actorOutranksTargetInAllGuilds / canEditGlobalUserFields ────────────────

describe('actorOutranksTargetInAllGuilds', () => {
  const ACTOR = '100000000000000001';
  const TARGET = '300000000000000001';
  const m = (guild_id: string, access_level: number) => ({ guild_id, name: 'g', voice_channel_id: null, access_level });

  function mockGuilds(actor: ReturnType<typeof m>[], target: ReturnType<typeof m>[]): void {
    vi.mocked(getGuildsForMember).mockImplementation(async (id: string) => (id === ACTOR ? actor : target));
  }

  it('passes vacuously when the target has no memberships', async () => {
    mockGuilds([], []);
    expect(await actorOutranksTargetInAllGuilds(ACTOR, TARGET)).toBe(true);
  });

  it('passes when the actor is an Admin or strictly above the target in each of the target\'s guilds', async () => {
    mockGuilds([m('a', AccessLevel.ADMIN), m('b', AccessLevel.MANAGER)], [m('a', AccessLevel.ADMIN), m('b', AccessLevel.MOD)]);
    expect(await actorOutranksTargetInAllGuilds(ACTOR, TARGET)).toBe(true);
  });

  it('fails when the actor is not a member of one of the target\'s guilds', async () => {
    mockGuilds([m('a', AccessLevel.ADMIN)], [m('a', AccessLevel.USER), m('b', AccessLevel.USER)]);
    expect(await actorOutranksTargetInAllGuilds(ACTOR, TARGET)).toBe(false);
  });

  it('fails when a non-Admin actor is at the target\'s level in one of their guilds', async () => {
    mockGuilds([m('a', AccessLevel.MANAGER)], [m('a', AccessLevel.MANAGER)]);
    expect(await actorOutranksTargetInAllGuilds(ACTOR, TARGET)).toBe(false);
  });
});

describe('canEditGlobalUserFields', () => {
  const GUILD_ID = '900000000000000001';
  const ACTOR = '100000000000000001';
  const TARGET = '300000000000000001';

  beforeEach(() => {
    vi.mocked(getGuildsForMember).mockResolvedValue([]);
    vi.mocked(getMemberAccessLevel).mockResolvedValue(0);
  });

  it('returns true when the target has no user row yet', async () => {
    vi.mocked(findUser).mockResolvedValue(null);
    expect(await canEditGlobalUserFields({ discordId: ACTOR }, TARGET, GUILD_ID)).toBe(true);
  });

  it('returns false for an existing user who is not a member of the current guild', async () => {
    vi.mocked(findUser).mockImplementation(async (id: string) => ({ discord_id: id, is_owner: false }) as any);
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
    expect(await canEditGlobalUserFields({ discordId: ACTOR }, TARGET, GUILD_ID)).toBe(false);
  });

  it('returns true for a bot owner actor even when the target is not a member', async () => {
    vi.mocked(findUser).mockImplementation(async (id: string) => ({ discord_id: id, is_owner: id === ACTOR }) as any);
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
    expect(await canEditGlobalUserFields({ discordId: ACTOR }, TARGET, GUILD_ID)).toBe(true);
  });

  it('defers to actorOutranksTargetInAllGuilds for an existing member of the current guild', async () => {
    vi.mocked(findUser).mockImplementation(async (id: string) => ({ discord_id: id, is_owner: false }) as any);
    vi.mocked(getGuildsForMember).mockImplementation(async (id: string) =>
      id === TARGET ? [{ guild_id: 'other', name: 'b', voice_channel_id: null, access_level: 0 }] : [],
    );
    expect(await canEditGlobalUserFields({ discordId: ACTOR }, TARGET, GUILD_ID)).toBe(false);
  });
});

// ─── handleDbError ───────────────────────────────────────────────────────────
