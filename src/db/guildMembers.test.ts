import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));
vi.mock('./users', () => ({
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
  findUser: vi.fn(),
}));

import { getPool } from './pool';
import { findUser } from './users';
import {
  getGuildMembers,
  getMemberAccessLevel,
  setMemberAccessLevel,
  removeGuildMember,
  getEffectiveAccessLevel,
} from './guildMembers';

function makePool() {
  return { execute: vi.fn().mockResolvedValue([[], []]) };
}

let pool: ReturnType<typeof makePool>;

beforeEach(() => {
  vi.clearAllMocks();
  pool = makePool();
  vi.mocked(getPool).mockReturnValue(pool as never);
});

describe('getGuildMembers', () => {
  it('maps rows and preserves BIGINT snowflakes as strings without precision loss', async () => {
    // These values exceed Number.MAX_SAFE_INTEGER; coercing to Number would corrupt them.
    const GUILD  = 915557543463727107n;
    const ALICE  = 799843684990877696n;
    const BOB    = 799843684990877697n;

    pool.execute.mockResolvedValueOnce([
      [
        { guild_id: GUILD, discord_id: ALICE, access_level: 3 },
        { guild_id: GUILD, discord_id: BOB,   access_level: 1 },
      ],
      [],
    ]);

    const result = await getGuildMembers(String(GUILD));

    expect(result).toEqual([
      { guild_id: '915557543463727107', discord_id: '799843684990877696', access_level: 3 },
      { guild_id: '915557543463727107', discord_id: '799843684990877697', access_level: 1 },
    ]);
  });
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
    expect(await getEffectiveAccessLevel('g1', '999')).toBe(0);
    // No guild_member lookup needed when there is no user row.
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('returns ADMIN (3) for a bot owner regardless of membership', async () => {
    vi.mocked(findUser).mockResolvedValueOnce({ ...baseUser, is_owner: true });
    expect(await getEffectiveAccessLevel('g1', '222')).toBe(3);
    // Owners short-circuit before any guild_member query.
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('reads the per-guild level from guild_member for a non-owner', async () => {
    vi.mocked(findUser).mockResolvedValueOnce({ ...baseUser });
    pool.execute.mockResolvedValueOnce([[{ access_level: 2 }], []]);
    expect(await getEffectiveAccessLevel('g1', '222')).toBe(2);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM guild_member');
    expect(params).toEqual(['g1', '222']);
  });

  it('defaults to USER (0) when a whitelisted non-owner has no membership in the guild', async () => {
    vi.mocked(findUser).mockResolvedValueOnce({ ...baseUser });
    pool.execute.mockResolvedValueOnce([[], []]);
    expect(await getEffectiveAccessLevel('g1', '222')).toBe(0);
  });
});
