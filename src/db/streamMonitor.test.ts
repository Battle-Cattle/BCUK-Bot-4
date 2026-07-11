import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import {
  getStreamGroupsForGuild,
  addStreamGroup,
  updateStreamGroup,
  getStreamersForGuild,
  getAllStreamersWithGroups,
  addStreamer,
  removeStreamer,
  removeStreamGroupAndStreamers,
  setStreamerLive,
  clearStreamerLive,
} from './streamMonitor';

const GUILD_ID = 'guild-1';

function makePool(rows: unknown[] = []) {
  return { execute: vi.fn().mockResolvedValue([[...rows], []]) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getStreamGroupsForGuild ───────────────────────────────────────────────────

describe('getStreamGroupsForGuild', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getStreamGroupsForGuild(GUILD_ID)).toEqual([]);
  });

  it('scopes the query to guildId', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getStreamGroupsForGuild(GUILD_ID);
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('guild_id = ?');
    expect(params).toEqual([GUILD_ID]);
  });

  it('maps multi_twitch as numeric 1 → true and coerces guild_id to string', async () => {
    const row = { id: 1, guild_id: 1n, name: 'G', discord_channel: '123', live_message: 'live', new_game_message: 'game', multi_twitch: 1, delete_old_posts: 0 };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [group] = await getStreamGroupsForGuild(GUILD_ID);
    expect(group.multi_twitch).toBe(true);
    expect(group.delete_old_posts).toBe(false);
    expect(group.guild_id).toBe('1');
  });

  it('maps multi_twitch as Buffer 0x01 → true', async () => {
    const row = { id: 1, guild_id: GUILD_ID, name: 'G', discord_channel: '123', live_message: 'l', new_game_message: 'g', multi_twitch: Buffer.from([1]), delete_old_posts: Buffer.from([0]) };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [group] = await getStreamGroupsForGuild(GUILD_ID);
    expect(group.multi_twitch).toBe(true);
    expect(group.delete_old_posts).toBe(false);
  });

  it('coerces discord_channel to string', async () => {
    const row = { id: 1, guild_id: GUILD_ID, name: 'G', discord_channel: 99999n, live_message: 'l', new_game_message: 'g', multi_twitch: 0, delete_old_posts: 0 };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [group] = await getStreamGroupsForGuild(GUILD_ID);
    expect(group.discord_channel).toBe('99999');
  });

  it('maps multiple rows', async () => {
    const rows = [
      { id: 1, guild_id: GUILD_ID, name: 'A', discord_channel: '1', live_message: '', new_game_message: '', multi_twitch: 0, delete_old_posts: 0 },
      { id: 2, guild_id: GUILD_ID, name: 'B', discord_channel: '2', live_message: '', new_game_message: '', multi_twitch: 1, delete_old_posts: 1 },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getStreamGroupsForGuild(GUILD_ID);
    expect(result).toHaveLength(2);
    expect(result[1].id).toBe(2);
    expect(result[1].multi_twitch).toBe(true);
  });
});

// ─── addStreamGroup ───────────────────────────────────────────────────────────

describe('addStreamGroup', () => {
  it('includes guildId as the first INSERT param', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await addStreamGroup({ guildId: GUILD_ID, name: 'G', discordChannel: '123', liveMessage: 'l', newGameMessage: 'g', multiTwitch: true, deleteOldPosts: false });
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params[0]).toBe(GUILD_ID);
    expect(params).toContain(1);  // multiTwitch
    expect(params).toContain(0);  // deleteOldPosts
  });

  it('includes all fields in the INSERT params', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await addStreamGroup({ guildId: GUILD_ID, name: 'MyGroup', discordChannel: 'chan1', liveMessage: 'is live', newGameMessage: 'new game', multiTwitch: false, deleteOldPosts: true });
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params).toContain('MyGroup');
    expect(params).toContain('chan1');
    expect(params).toContain('is live');
    expect(params).toContain('new game');
  });
});

// ─── updateStreamGroup ────────────────────────────────────────────────────────

describe('updateStreamGroup', () => {
  it('includes the id and guildId as the last WHERE params', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await updateStreamGroup({ id: 42, guildId: GUILD_ID, name: 'G', discordChannel: 'c', liveMessage: 'l', newGameMessage: 'g', multiTwitch: false, deleteOldPosts: false });
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params[params.length - 2]).toBe(42);
    expect(params[params.length - 1]).toBe(GUILD_ID);
  });

  it('uses UPDATE and scopes the WHERE to guild_id', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await updateStreamGroup({ id: 1, guildId: GUILD_ID, name: 'G', discordChannel: 'c', liveMessage: 'l', newGameMessage: 'g', multiTwitch: false, deleteOldPosts: false });
    const sql = (pool.execute.mock.calls[0][0] as string).toLowerCase();
    expect(sql).toContain('update');
    expect(sql).toContain('guild_id=?');
  });

  it('returns true when a row was updated', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await updateStreamGroup({ id: 1, guildId: GUILD_ID, name: 'G', discordChannel: 'c', liveMessage: 'l', newGameMessage: 'g', multiTwitch: false, deleteOldPosts: false });
    expect(result).toBe(true);
  });

  it('returns false when the group did not belong to guildId (no row updated)', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 0 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await updateStreamGroup({ id: 1, guildId: GUILD_ID, name: 'G', discordChannel: 'c', liveMessage: 'l', newGameMessage: 'g', multiTwitch: false, deleteOldPosts: false });
    expect(result).toBe(false);
  });
});

// ─── removeStreamGroupAndStreamers ────────────────────────────────────────────

/** Pool mock whose getConnection() returns a fake transactional connection. */
function makeTransactionalPool(streamerAffectedRows: number, groupAffectedRows: number) {
  const conn = {
    execute: vi.fn()
      .mockResolvedValueOnce([{ affectedRows: streamerAffectedRows }, []])
      .mockResolvedValueOnce([{ affectedRows: groupAffectedRows }, []]),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  return {
    getConnection: vi.fn().mockResolvedValue(conn),
    _conn: conn,
  };
}

describe('removeStreamGroupAndStreamers', () => {
  it('deletes streamers then the group within a single transaction, returning true when the group was deleted', async () => {
    const pool = makeTransactionalPool(3, 1);
    vi.mocked(getPool).mockReturnValue(pool as any);

    const result = await removeStreamGroupAndStreamers(7, GUILD_ID);

    expect(pool._conn.beginTransaction).toHaveBeenCalledOnce();
    expect(pool._conn.execute).toHaveBeenCalledTimes(2);
    const [streamerSql, streamerParams] = pool._conn.execute.mock.calls[0] as [string, unknown[]];
    expect(streamerSql.toLowerCase()).toContain('delete');
    expect(streamerParams).toEqual([7, GUILD_ID]);
    const [groupSql, groupParams] = pool._conn.execute.mock.calls[1] as [string, unknown[]];
    expect(groupSql.toLowerCase()).toContain('delete');
    expect(groupParams).toEqual([7, GUILD_ID]);
    expect(pool._conn.commit).toHaveBeenCalledOnce();
    expect(pool._conn.release).toHaveBeenCalledOnce();
    expect(result).toBe(true);
  });

  it('returns false and still commits when the group did not belong to guildId (no row deleted)', async () => {
    const pool = makeTransactionalPool(0, 0);
    vi.mocked(getPool).mockReturnValue(pool as any);

    const result = await removeStreamGroupAndStreamers(7, GUILD_ID);

    expect(pool._conn.commit).toHaveBeenCalledOnce();
    expect(result).toBe(false);
  });

  it('rolls back and releases the connection when a delete throws', async () => {
    const conn = {
      execute: vi.fn().mockRejectedValue(new Error('DB down')),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    await expect(removeStreamGroupAndStreamers(7, GUILD_ID)).rejects.toThrow('DB down');
    expect(conn.rollback).toHaveBeenCalledOnce();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledOnce();
  });
});

// ─── getStreamersForGuild ──────────────────────────────────────────────────────

describe('getStreamersForGuild', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getStreamersForGuild(GUILD_ID)).toEqual([]);
  });

  it('scopes the query to guild_id via the joined stream_group', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getStreamersForGuild(GUILD_ID);
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('g.guild_id = ?');
    expect(params).toEqual([GUILD_ID]);
  });

  it('maps rows and coerces discord_id to string', async () => {
    const row = { id: 1, discord_id: 123n, group_id: 5, twitch_name: 'alice', discord_name: 'Alice', group_name: 'Group A' };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [s] = await getStreamersForGuild(GUILD_ID);
    expect(s.discord_id).toBe('123');
    expect(s.twitch_name).toBe('alice');
    expect(s.group_name).toBe('Group A');
  });

  it('maps null twitch_name and discord_name to null', async () => {
    const row = { id: 2, discord_id: '456', group_id: 1, twitch_name: null, discord_name: null, group_name: 'G' };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [s] = await getStreamersForGuild(GUILD_ID);
    expect(s.twitch_name).toBeNull();
    expect(s.discord_name).toBeNull();
  });
});

// ─── getAllStreamersWithGroups ─────────────────────────────────────────────────

describe('getAllStreamersWithGroups', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getAllStreamersWithGroups()).toEqual([]);
  });

  it('is not scoped to any single guild (used by the cross-guild monitor)', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getAllStreamersWithGroups();
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[] | undefined];
    expect(sql).not.toContain('WHERE');
    expect(params ?? []).toEqual([]);
  });

  it('builds nested group object from flat row, including guild_id', async () => {
    const row = {
      id: 1, discord_id: '111', group_id: 2, twitch_name: 'alice',
      discord_message_id: 'msg1', discord_channel_id: 'chan1', live_game: 'Minecraft',
      guild_id: GUILD_ID, group_name: 'Streamers', discord_channel: 'ch', live_message: 'live', new_game_message: 'newgame',
      multi_twitch: 1, delete_old_posts: 0,
    };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [s] = await getAllStreamersWithGroups();
    expect(s.live_game).toBe('Minecraft');
    expect(s.discord_message_id).toBe('msg1');
    expect(s.group.id).toBe(2);
    expect(s.group.guild_id).toBe(GUILD_ID);
    expect(s.group.multi_twitch).toBe(true);
    expect(s.group.delete_old_posts).toBe(false);
  });

  it('coerces discord_channel_id to string when set', async () => {
    const row = {
      id: 1, discord_id: '1', group_id: 1, twitch_name: 'bob',
      discord_message_id: null, discord_channel_id: 99999n, live_game: null,
      guild_id: GUILD_ID, group_name: 'G', discord_channel: 'c', live_message: 'l', new_game_message: 'g',
      multi_twitch: 0, delete_old_posts: 0,
    };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [s] = await getAllStreamersWithGroups();
    expect(s.discord_channel_id).toBe('99999');
  });

  it('maps null discord_channel_id to null', async () => {
    const row = {
      id: 1, discord_id: '1', group_id: 1, twitch_name: 'bob',
      discord_message_id: null, discord_channel_id: null, live_game: null,
      guild_id: GUILD_ID, group_name: 'G', discord_channel: 'c', live_message: 'l', new_game_message: 'g',
      multi_twitch: 0, delete_old_posts: 0,
    };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [s] = await getAllStreamersWithGroups();
    expect(s.discord_channel_id).toBeNull();
  });
});

// ─── addStreamer / removeStreamer ─────────────────────────────────────────────

describe('addStreamer', () => {
  it('inserts with discordId and groupId after confirming the group belongs to guildId', async () => {
    const conn = makePool([{ 1: 1 }]);
    vi.mocked(getPool).mockReturnValue(conn as any);
    await addStreamer('user1', 3, GUILD_ID);
    expect(conn.execute).toHaveBeenNthCalledWith(1, expect.stringContaining('SELECT'), [3, GUILD_ID]);
    expect(conn.execute).toHaveBeenNthCalledWith(2, expect.stringContaining('INSERT'), ['user1', 3]);
  });

  it('throws and does not insert when the group does not belong to guildId', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    await expect(addStreamer('user1', 3, GUILD_ID)).rejects.toThrow('does not belong to guild');
  });
});

describe('removeStreamer', () => {
  it('deletes by id, scoped to guildId via the joined group, returning true when deleted', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await removeStreamer(5, GUILD_ID);
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([5, GUILD_ID]);
    expect(sql).toContain('g.guild_id = ?');
    expect(result).toBe(true);
  });

  it('returns false when the streamer\'s group did not belong to guildId', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 0 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await removeStreamer(5, GUILD_ID)).toBe(false);
  });
});

// ─── setStreamerLive / clearStreamerLive ──────────────────────────────────────

describe('setStreamerLive', () => {
  it('updates with messageId, channelId, game, and id', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await setStreamerLive(1, 'msg42', 'chan99', 'Fortnite');
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params).toContain('msg42');
    expect(params).toContain('chan99');
    expect(params).toContain('Fortnite');
    expect(params).toContain(1);
  });
});

describe('clearStreamerLive', () => {
  it('executes UPDATE with id', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await clearStreamerLive(7);
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql.toLowerCase()).toContain('update');
    expect(params).toContain(7);
  });
});
