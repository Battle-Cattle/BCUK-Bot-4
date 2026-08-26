import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../test-utils/accessLevelMock';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));
vi.mock('./users', () => ({
  AccessLevel: ACCESS_LEVEL_MOCK,
  findUser: vi.fn(),
}));

import { getPool } from './pool';
import { findUser, AccessLevel } from './users';
import {
  getMemberAccessLevel,
  setMemberAccessLevel,
  removeGuildMember,
  getEffectiveAccessLevel,
  getEffectiveAccessLevelForUser,
} from './guildMembers';
import { makeMockPool, type MockPool } from '../test-utils/mockMysqlPool';

let pool: MockPool;

beforeEach(() => {
  vi.clearAllMocks();
  pool = makeMockPool();
  vi.mocked(getPool).mockReturnValue(pool as never);
});

describe('getMemberAccessLevel', () => {
  it('returns the access level when a row exists', async () => {
    pool.execute.mockResolvedValueOnce([[{ access_level: 2 }], []]);
    expect(await getMemberAccessLevel('111', '222')).toBe(2);
  });

  it('returns null when no membership row exists', async () => {
    pool.execute.mockResolvedValueOnce([[], []]);
    expect(await getMemberAccessLevel('111', '999')).toBeNull();
  });
});

describe('setMemberAccessLevel', () => {
  it('upserts the membership row', async () => {
    await setMemberAccessLevel('111', '222', 2);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO guild_member');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE access_level = new_member.access_level');
    expect(params).toEqual(['111', '222', 2]);
  });

  it('rejects an invalid access level', async () => {
    await expect(setMemberAccessLevel('111', '222', 7)).rejects.toThrow('Invalid accessLevel');
    expect(pool.execute).not.toHaveBeenCalled();
  });
});

describe('removeGuildMember', () => {
  it('deletes the membership row', async () => {
    await removeGuildMember('111', '222');
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM guild_member'),
      ['111', '222'],
    );
  });
});

describe('getEffectiveAccessLevel', () => {
  const baseUser = {
    discord_id: '222',
    discord_name: 'Alice',
    is_twitch_bot_enabled: false,
    twitch_name: null,
    access_level: 0,
    is_owner: false,
  };

  it('defaults to USER (0) when the user is not whitelisted', async () => {
    vi.mocked(findUser).mockResolvedValueOnce(null);
    expect(await getEffectiveAccessLevel('g1', '999')).toBe(AccessLevel.USER);
    // No guild_member lookup needed when there is no user row.
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('returns ADMIN (3) for a bot owner regardless of membership', async () => {
    vi.mocked(findUser).mockResolvedValueOnce({ ...baseUser, is_owner: true });
    expect(await getEffectiveAccessLevel('g1', '222')).toBe(AccessLevel.ADMIN);
    // Owners short-circuit before any guild_member query.
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('reads the per-guild level from guild_member for a non-owner', async () => {
    vi.mocked(findUser).mockResolvedValueOnce({ ...baseUser });
    pool.execute.mockResolvedValueOnce([[{ access_level: 2 }], []]);
    expect(await getEffectiveAccessLevel('g1', '222')).toBe(AccessLevel.MANAGER);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM guild_member');
    expect(params).toEqual(['g1', '222']);
  });

  it('defaults to USER (0) when a whitelisted non-owner has no membership in the guild', async () => {
    vi.mocked(findUser).mockResolvedValueOnce({ ...baseUser });
    pool.execute.mockResolvedValueOnce([[], []]);
    expect(await getEffectiveAccessLevel('g1', '222')).toBe(AccessLevel.USER);
  });
});

describe('getEffectiveAccessLevelForUser', () => {
  const baseUser = {
    discord_id: '222',
    discord_name: 'Alice',
    is_twitch_bot_enabled: false,
    twitch_name: null,
    access_level: 0,
    is_owner: false,
  };

  it('returns ADMIN (3) for a bot owner regardless of membership, without a DB call', async () => {
    expect(await getEffectiveAccessLevelForUser('g1', { ...baseUser, is_owner: true })).toBe(AccessLevel.ADMIN);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('reads the per-guild level from guild_member for a non-owner', async () => {
    pool.execute.mockResolvedValueOnce([[{ access_level: 2 }], []]);
    expect(await getEffectiveAccessLevelForUser('g1', { ...baseUser })).toBe(AccessLevel.MANAGER);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM guild_member');
    expect(params).toEqual(['g1', '222']);
  });

  it('defaults to USER (0) when a non-owner has no membership in the guild', async () => {
    pool.execute.mockResolvedValueOnce([[], []]);
    expect(await getEffectiveAccessLevelForUser('g1', { ...baseUser })).toBe(AccessLevel.USER);
  });
});
