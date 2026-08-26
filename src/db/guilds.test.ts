import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import { getAllGuilds, getProvisionedGuilds, getGuildById, getGuildsForMember, upsertGuild } from './guilds';
import { makeMockPool, type MockPool } from '../test-utils/mockMysqlPool';

let pool: MockPool;

beforeEach(() => {
  vi.clearAllMocks();
  pool = makeMockPool();
  vi.mocked(getPool).mockReturnValue(pool as never);
});

describe('getAllGuilds', () => {
  it('maps rows and stringifies BIGINT columns', async () => {
    pool.execute.mockResolvedValueOnce([
      [
        { guild_id: 111n, name: 'Alpha', voice_channel_id: 222n },
        { guild_id: 333n, name: 'Beta', voice_channel_id: null },
      ],
      [],
    ]);

    const result = await getAllGuilds();

    expect(result).toEqual([
      { guild_id: '111', name: 'Alpha', voice_channel_id: '222' },
      { guild_id: '333', name: 'Beta', voice_channel_id: null },
    ]);
  });

  it('returns an empty array when no guilds exist', async () => {
    pool.execute.mockResolvedValueOnce([[], []]);
    expect(await getAllGuilds()).toEqual([]);
  });
});

describe('getGuildsForMember', () => {
  it('joins guild_member and maps BIGINT columns plus access_level for the given user', async () => {
    pool.execute.mockResolvedValueOnce([
      [{ guild_id: 111n, name: 'Alpha', voice_channel_id: 222n, access_level: 2 }],
      [],
    ]);

    const result = await getGuildsForMember('555');

    expect(result).toEqual([{ guild_id: '111', name: 'Alpha', voice_channel_id: '222', access_level: 2 }]);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('JOIN guild_member');
    expect(sql).toContain('gm.access_level');
    expect(params).toEqual(['555']);
  });

  it('returns an empty array when the user belongs to no guild', async () => {
    pool.execute.mockResolvedValueOnce([[], []]);
    expect(await getGuildsForMember('555')).toEqual([]);
  });
});

describe('getProvisionedGuilds', () => {
  it('filters to guilds with at least one member and maps BIGINT columns', async () => {
    pool.execute.mockResolvedValueOnce([
      [{ guild_id: 111n, name: 'Alpha', voice_channel_id: 222n }],
      [],
    ]);

    const result = await getProvisionedGuilds();

    expect(result).toEqual([{ guild_id: '111', name: 'Alpha', voice_channel_id: '222' }]);
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('guild_member');
  });

  it('returns an empty array when no guild has members', async () => {
    pool.execute.mockResolvedValueOnce([[], []]);
    expect(await getProvisionedGuilds()).toEqual([]);
  });
});

describe('getGuildById', () => {
  it('returns the mapped guild when found', async () => {
    pool.execute.mockResolvedValueOnce([
      [{ guild_id: 111, name: 'Alpha', voice_channel_id: 222 }],
      [],
    ]);

    const result = await getGuildById('111');

    expect(result).toEqual({ guild_id: '111', name: 'Alpha', voice_channel_id: '222' });
    expect(pool.execute).toHaveBeenCalledWith(expect.stringContaining('WHERE guild_id = ?'), ['111']);
  });

  it('returns null when the guild is not registered', async () => {
    pool.execute.mockResolvedValueOnce([[], []]);
    expect(await getGuildById('999')).toBeNull();
  });
});

describe('upsertGuild', () => {
  it('inserts with a name-only conflict update so existing config is preserved', async () => {
    await upsertGuild('111', 'Alpha');

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO guild');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE name = new_guild.name');
    expect(sql).not.toContain('voice_channel_id =');
    expect(params).toEqual(['111', 'Alpha']);
  });
});
