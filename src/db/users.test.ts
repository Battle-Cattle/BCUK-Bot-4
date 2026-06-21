import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));
vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));
vi.mock('../twitch/twitchChannelName', () => ({
  normalizeTwitchChannelName: vi.fn((s: string) => (s ? s.toLowerCase() : null)),
}));

import { getPool } from './pool';
import {
  findUser,
  findUserByTwitchName,
  getAllUsers,
  upsertUserRecord,
  updateDiscordName,
  getTwitchEnabledChannels,
  setTwitchBotEnabledRecord,
  updateAccessLevel,
  removeUserRecord,
  AccessLevel,
} from './users';
import { normalizeTwitchChannelName } from '../twitch/twitchChannelName';

function makeConnection(executeResult: unknown = [[], []]) {
  return {
    execute: vi.fn().mockResolvedValue(executeResult),
    release: vi.fn(),
  };
}

function makePool(executeResult: unknown = [[], []], connectionExecuteResult?: unknown) {
  const conn = makeConnection(connectionExecuteResult ?? [[], []]);
  return {
    execute: vi.fn().mockResolvedValue(executeResult),
    getConnection: vi.fn().mockResolvedValue(conn),
    _conn: conn,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(normalizeTwitchChannelName).mockImplementation((s: string) => (s ? s.toLowerCase() : null));
});

// ─── findUser ────────────────────────────────────────────────────────────────

describe('findUser', () => {
  it('returns null when no rows found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([[]]  ) as any);
    const result = await findUser('123');
    expect(result).toBeNull();
  });

  it('maps a row with numeric is_twitch_bot_enabled = 1 to true', async () => {
    const row = { discord_id: '123', discord_name: 'Alice', is_twitch_bot_enabled: 1, twitch_name: 'alice', access_level: 0 };
    vi.mocked(getPool).mockReturnValue(makePool([[row]]) as any);
    const user = await findUser('123');
    expect(user).not.toBeNull();
    expect(user!.is_twitch_bot_enabled).toBe(true);
    expect(user!.discord_id).toBe('123');
  });

  it('maps a row with numeric is_twitch_bot_enabled = 0 to false', async () => {
    const row = { discord_id: '456', discord_name: 'Bob', is_twitch_bot_enabled: 0, twitch_name: null, access_level: 1 };
    vi.mocked(getPool).mockReturnValue(makePool([[row]]) as any);
    const user = await findUser('456');
    expect(user!.is_twitch_bot_enabled).toBe(false);
  });

  it('maps a row with Buffer is_twitch_bot_enabled 0x01 to true', async () => {
    const row = { discord_id: '789', discord_name: 'Carol', is_twitch_bot_enabled: Buffer.from([1]), twitch_name: 'carol', access_level: 2 };
    vi.mocked(getPool).mockReturnValue(makePool([[row]]) as any);
    const user = await findUser('789');
    expect(user!.is_twitch_bot_enabled).toBe(true);
  });

  it('maps a row with Buffer is_twitch_bot_enabled 0x00 to false', async () => {
    const row = { discord_id: '789', discord_name: 'Carol', is_twitch_bot_enabled: Buffer.from([0]), twitch_name: 'carol', access_level: 2 };
    vi.mocked(getPool).mockReturnValue(makePool([[row]]) as any);
    const user = await findUser('789');
    expect(user!.is_twitch_bot_enabled).toBe(false);
  });

  it('coerces discord_id to string', async () => {
    const row = { discord_id: 999n, discord_name: 'Bigint', is_twitch_bot_enabled: 0, twitch_name: null, access_level: 0 };
    vi.mocked(getPool).mockReturnValue(makePool([[row]]) as any);
    const user = await findUser('999');
    expect(user!.discord_id).toBe('999');
  });

  it('maps the is_owner bit column to a boolean', async () => {
    const ownerRow = { discord_id: '1', discord_name: 'Owner', is_twitch_bot_enabled: 0, twitch_name: null, access_level: 3, is_owner: Buffer.from([1]) };
    vi.mocked(getPool).mockReturnValue(makePool([[ownerRow]]) as any);
    expect((await findUser('1'))!.is_owner).toBe(true);

    const plainRow = { discord_id: '2', discord_name: 'User', is_twitch_bot_enabled: 0, twitch_name: null, access_level: 0, is_owner: 0 };
    vi.mocked(getPool).mockReturnValue(makePool([[plainRow]]) as any);
    expect((await findUser('2'))!.is_owner).toBe(false);
  });
});

// ─── findUserByTwitchName ─────────────────────────────────────────────────────

describe('findUserByTwitchName', () => {
  it('returns null when normalizeTwitchChannelName returns null (blank/invalid name)', async () => {
    vi.mocked(normalizeTwitchChannelName).mockReturnValue(null);
    const pool = makePool([[]]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await findUserByTwitchName('');
    expect(result).toBeNull();
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('returns null when query returns no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([[]]) as any);
    const result = await findUserByTwitchName('alice');
    expect(result).toBeNull();
  });

  it('maps a found row correctly', async () => {
    const row = {
      discord_id: '111',
      discord_name: 'Alice',
      is_twitch_bot_enabled: 1,
      twitch_name: 'alice',
      access_level: 0,
      is_owner: Buffer.from([1]),
    };
    vi.mocked(getPool).mockReturnValue(makePool([[row]]) as any);
    const result = await findUserByTwitchName('alice');
    expect(result!.discord_id).toBe('111');
    expect(result!.is_owner).toBe(true);
  });

  it('uses an exclude query when excludeDiscordId is provided', async () => {
    const pool = makePool([[]]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await findUserByTwitchName('alice', '999');
    const sql: string = vi.mocked(pool.execute).mock.calls[0][0] as string;
    expect(sql).toContain('discord_id <> ?');
  });

  it('does not use an exclude clause when no excludeDiscordId provided', async () => {
    const pool = makePool([[]]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await findUserByTwitchName('alice');
    const sql: string = vi.mocked(pool.execute).mock.calls[0][0] as string;
    expect(sql).not.toContain('discord_id <> ?');
  });
});

// ─── getAllUsers ──────────────────────────────────────────────────────────────

describe('getAllUsers', () => {
  it('returns an empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([[]]) as any);
    const result = await getAllUsers();
    expect(result).toEqual([]);
  });

  it('maps multiple rows', async () => {
    const rows = [
      { discord_id: '1', discord_name: 'A', is_twitch_bot_enabled: 0, twitch_name: null, access_level: 3, is_owner: 1 },
      { discord_id: '2', discord_name: 'B', is_twitch_bot_enabled: 1, twitch_name: 'b', access_level: 0, is_owner: 0 },
    ];
    vi.mocked(getPool).mockReturnValue(makePool([rows]) as any);
    const result = await getAllUsers();
    expect(result).toHaveLength(2);
    expect(result[0].discord_id).toBe('1');
    expect(result[1].is_twitch_bot_enabled).toBe(true);
    expect(result[0].is_owner).toBe(true);
    expect(result[1].is_owner).toBe(false);
  });
});

// ─── upsertUserRecord ─────────────────────────────────────────────────────────

describe('upsertUserRecord', () => {
  it('throws for an invalid access level', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(upsertUserRecord('1', 'Alice', 99)).rejects.toThrow('Invalid accessLevel: 99');
  });

  it('accepts all valid access levels', async () => {
    for (const level of Object.values(AccessLevel)) {
      const pool = makePool();
      vi.mocked(getPool).mockReturnValue(pool as any);
      await expect(upsertUserRecord('1', 'Alice', level)).resolves.not.toThrow();
    }
  });

  it('returns true when twitchName is provided (even if null)', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    const result = await upsertUserRecord('1', 'Alice', 0, null);
    expect(result).toBe(true);
  });

  it('returns false when twitchName is not provided (undefined)', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    const result = await upsertUserRecord('1', 'Alice', 0);
    expect(result).toBe(false);
  });

  it('throws when twitchName is an empty string', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(upsertUserRecord('1', 'Alice', 0, '')).rejects.toThrow('Invalid twitchName');
  });

  it('throws when twitchName is whitespace-only', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(upsertUserRecord('1', 'Alice', 0, '   ')).rejects.toThrow('Invalid twitchName');
  });

  it('throws when normalizeTwitchChannelName returns null for twitchName', async () => {
    vi.mocked(normalizeTwitchChannelName).mockReturnValue(null);
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(upsertUserRecord('1', 'Alice', 0, 'invalid!')).rejects.toThrow('Invalid twitchName');
  });

  it('trims discordName and passes null when blank', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await upsertUserRecord('1', '   ', 0);
    const params = pool._conn.execute.mock.calls[1][1] as unknown[];
    expect(params[1]).toBeNull();
  });
});

// ─── updateDiscordName ────────────────────────────────────────────────────────

describe('updateDiscordName', () => {
  it('passes trimmed name to the query', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await updateDiscordName('1', '  Alice  ');
    expect(pool.execute).toHaveBeenCalledWith(expect.any(String), ['Alice', '1']);
  });

  it('passes null when name is blank after trimming', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await updateDiscordName('1', '   ');
    expect(pool.execute).toHaveBeenCalledWith(expect.any(String), [null, '1']);
  });
});

// ─── getTwitchEnabledChannels ─────────────────────────────────────────────────

describe('getTwitchEnabledChannels', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([[]]) as any);
    const result = await getTwitchEnabledChannels();
    expect(result).toEqual([]);
  });

  it('maps twitch_name through normalizeTwitchChannelName', async () => {
    vi.mocked(normalizeTwitchChannelName).mockImplementation((s) => `normalized_${s}`);
    const rows = [{ twitch_name: 'Alice' }, { twitch_name: 'Bob' }];
    vi.mocked(getPool).mockReturnValue(makePool([rows]) as any);
    const result = await getTwitchEnabledChannels();
    expect(result).toEqual(['normalized_Alice', 'normalized_Bob']);
  });

  it('filters out entries where normalizeTwitchChannelName returns null', async () => {
    vi.mocked(normalizeTwitchChannelName).mockReturnValueOnce('alice').mockReturnValueOnce(null);
    const rows = [{ twitch_name: 'alice' }, { twitch_name: 'bad!' }];
    vi.mocked(getPool).mockReturnValue(makePool([rows]) as any);
    const result = await getTwitchEnabledChannels();
    expect(result).toEqual(['alice']);
  });
});

// ─── updateAccessLevel ────────────────────────────────────────────────────────

describe('updateAccessLevel', () => {
  it('throws for an invalid access level', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(updateAccessLevel('1', 5)).rejects.toThrow('Invalid accessLevel: 5');
  });

  it('accepts all valid access levels', async () => {
    for (const level of Object.values(AccessLevel)) {
      vi.mocked(getPool).mockReturnValue(makePool() as any);
      await expect(updateAccessLevel('1', level)).resolves.not.toThrow();
    }
  });
});

// ─── setTwitchBotEnabledRecord ────────────────────────────────────────────────

describe('setTwitchBotEnabledRecord', () => {
  it('passes 1 when enabled=true', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await setTwitchBotEnabledRecord('1', true);
    const params = pool._conn.execute.mock.calls[1][1] as unknown[];
    expect(params[0]).toBe(1);
  });

  it('passes 0 when enabled=false', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await setTwitchBotEnabledRecord('1', false);
    const params = pool._conn.execute.mock.calls[1][1] as unknown[];
    expect(params[0]).toBe(0);
  });
});

// ─── removeUserRecord ─────────────────────────────────────────────────────────

describe('removeUserRecord', () => {
  it('executes a DELETE with the discord_id', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await removeUserRecord('42');
    const sql: string = pool._conn.execute.mock.calls[1][0] as string;
    expect(sql).toContain('DELETE FROM');
    const params = pool._conn.execute.mock.calls[1][1] as unknown[];
    expect(params).toContain('42');
  });
});

// ─── AccessLevel constant ─────────────────────────────────────────────────────

describe('AccessLevel', () => {
  it('has USER=0, MOD=1, MANAGER=2, ADMIN=3', () => {
    expect(AccessLevel.USER).toBe(0);
    expect(AccessLevel.MOD).toBe(1);
    expect(AccessLevel.MANAGER).toBe(2);
    expect(AccessLevel.ADMIN).toBe(3);
  });
});
