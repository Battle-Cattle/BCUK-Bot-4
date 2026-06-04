import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import {
  getAllStreamGroups,
  addStreamGroup,
  updateStreamGroup,
  removeStreamGroup,
  getAllStreamers,
  getAllStreamersWithGroups,
  addStreamer,
  removeStreamer,
  removeStreamersByGroup,
  setStreamerLive,
  clearStreamerLive,
} from './streamMonitor';

function makePool(rows: unknown[] = []) {
  return { execute: vi.fn().mockResolvedValue([[...rows], []]) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getAllStreamGroups ────────────────────────────────────────────────────────

describe('getAllStreamGroups', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getAllStreamGroups()).toEqual([]);
  });

  it('maps multi_twitch as numeric 1 → true', async () => {
    const row = { id: 1, name: 'G', discord_channel: '123', live_message: 'live', new_game_message: 'game', multi_twitch: 1, delete_old_posts: 0 };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [group] = await getAllStreamGroups();
    expect(group.multi_twitch).toBe(true);
    expect(group.delete_old_posts).toBe(false);
  });

  it('maps multi_twitch as Buffer 0x01 → true', async () => {
    const row = { id: 1, name: 'G', discord_channel: '123', live_message: 'l', new_game_message: 'g', multi_twitch: Buffer.from([1]), delete_old_posts: Buffer.from([0]) };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [group] = await getAllStreamGroups();
    expect(group.multi_twitch).toBe(true);
    expect(group.delete_old_posts).toBe(false);
  });

  it('coerces discord_channel to string', async () => {
    const row = { id: 1, name: 'G', discord_channel: 99999n, live_message: 'l', new_game_message: 'g', multi_twitch: 0, delete_old_posts: 0 };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [group] = await getAllStreamGroups();
    expect(group.discord_channel).toBe('99999');
  });

  it('maps multiple rows', async () => {
    const rows = [
      { id: 1, name: 'A', discord_channel: '1', live_message: '', new_game_message: '', multi_twitch: 0, delete_old_posts: 0 },
      { id: 2, name: 'B', discord_channel: '2', live_message: '', new_game_message: '', multi_twitch: 1, delete_old_posts: 1 },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getAllStreamGroups();
    expect(result).toHaveLength(2);
    expect(result[1].id).toBe(2);
    expect(result[1].multi_twitch).toBe(true);
  });
});

// ─── addStreamGroup ───────────────────────────────────────────────────────────

describe('addStreamGroup', () => {
  it('passes multiTwitch=true as 1 and deleteOldPosts=false as 0', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await addStreamGroup({ name: 'G', discordChannel: '123', liveMessage: 'l', newGameMessage: 'g', multiTwitch: true, deleteOldPosts: false });
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params).toContain(1);  // multiTwitch
    expect(params).toContain(0);  // deleteOldPosts
  });

  it('includes all fields in the INSERT params', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await addStreamGroup({ name: 'MyGroup', discordChannel: 'chan1', liveMessage: 'is live', newGameMessage: 'new game', multiTwitch: false, deleteOldPosts: true });
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params).toContain('MyGroup');
    expect(params).toContain('chan1');
    expect(params).toContain('is live');
    expect(params).toContain('new game');
  });
});

// ─── updateStreamGroup ────────────────────────────────────────────────────────

describe('updateStreamGroup', () => {
  it('includes the id as the last WHERE param', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await updateStreamGroup({ id: 42, name: 'G', discordChannel: 'c', liveMessage: 'l', newGameMessage: 'g', multiTwitch: false, deleteOldPosts: false });
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params[params.length - 1]).toBe(42);
  });

  it('uses UPDATE in the SQL', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await updateStreamGroup({ id: 1, name: 'G', discordChannel: 'c', liveMessage: 'l', newGameMessage: 'g', multiTwitch: false, deleteOldPosts: false });
    expect((pool.execute.mock.calls[0][0] as string).toLowerCase()).toContain('update');
  });
});

// ─── removeStreamGroup ────────────────────────────────────────────────────────

describe('removeStreamGroup', () => {
  it('executes DELETE with the group id', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await removeStreamGroup(7);
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params).toContain(7);
    expect((pool.execute.mock.calls[0][0] as string).toLowerCase()).toContain('delete');
  });
});

// ─── getAllStreamers ──────────────────────────────────────────────────────────

describe('getAllStreamers', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getAllStreamers()).toEqual([]);
  });

  it('maps rows and coerces discord_id to string', async () => {
    const row = { id: 1, discord_id: 123n, group_id: 5, twitch_name: 'alice', discord_name: 'Alice', group_name: 'Group A' };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [s] = await getAllStreamers();
    expect(s.discord_id).toBe('123');
    expect(s.twitch_name).toBe('alice');
    expect(s.group_name).toBe('Group A');
  });

  it('maps null twitch_name and discord_name to null', async () => {
    const row = { id: 2, discord_id: '456', group_id: 1, twitch_name: null, discord_name: null, group_name: 'G' };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [s] = await getAllStreamers();
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

  it('builds nested group object from flat row', async () => {
    const row = {
      id: 1, discord_id: '111', group_id: 2, twitch_name: 'alice',
      discord_message_id: 'msg1', discord_channel_id: 'chan1', live_game: 'Minecraft',
      group_name: 'Streamers', discord_channel: 'ch', live_message: 'live', new_game_message: 'newgame',
      multi_twitch: 1, delete_old_posts: 0,
    };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [s] = await getAllStreamersWithGroups();
    expect(s.live_game).toBe('Minecraft');
    expect(s.discord_message_id).toBe('msg1');
    expect(s.group.id).toBe(2);
    expect(s.group.multi_twitch).toBe(true);
    expect(s.group.delete_old_posts).toBe(false);
  });

  it('coerces discord_channel_id to string when set', async () => {
    const row = {
      id: 1, discord_id: '1', group_id: 1, twitch_name: 'bob',
      discord_message_id: null, discord_channel_id: 99999n, live_game: null,
      group_name: 'G', discord_channel: 'c', live_message: 'l', new_game_message: 'g',
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
      group_name: 'G', discord_channel: 'c', live_message: 'l', new_game_message: 'g',
      multi_twitch: 0, delete_old_posts: 0,
    };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [s] = await getAllStreamersWithGroups();
    expect(s.discord_channel_id).toBeNull();
  });
});

// ─── addStreamer / removeStreamer / removeStreamersByGroup ────────────────────

describe('addStreamer', () => {
  it('inserts with discordId and groupId', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await addStreamer('user1', 3);
    expect(pool.execute.mock.calls[0][1]).toEqual(['user1', 3]);
  });
});

describe('removeStreamer', () => {
  it('deletes by id', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await removeStreamer(5);
    expect(pool.execute.mock.calls[0][1]).toContain(5);
  });
});

describe('removeStreamersByGroup', () => {
  it('deletes by group_id', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await removeStreamersByGroup(10);
    expect(pool.execute.mock.calls[0][1]).toContain(10);
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
