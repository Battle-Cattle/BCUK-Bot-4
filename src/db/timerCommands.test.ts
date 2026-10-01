import { describe, it, expect, vi, beforeEach } from 'vitest';

// `withTransaction` is reimplemented on top of the mocked `getPool()` so the owner-checked writes
// run their SQL against the test's fake connection.
vi.mock('./pool', () => {
  const getPool = vi.fn();
  return {
    getPool,
    withTransaction: async (work: (conn: unknown) => Promise<unknown>) => {
      const conn = await getPool().getConnection();
      try {
        await conn.beginTransaction();
        const result = await work(conn);
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    },
  };
});
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import {
  getAllTimerCommandsWithAssignments,
  addTimerCommand,
  updateTimerCommand,
  removeTimerCommand,
  setTimerCommandEnabled,
  assignUserToTimer,
  assignUsersToTimer,
  unassignUserFromTimer,
  getAllEnabledTimerCommandsWithChannel,
  TimerCommandNotFoundError,
  updateOwnTimerCommand,
  setOwnTimerCommandEnabled,
  removeOwnTimerCommand,
  discardOwnNewTimerCommand,
  type TimerCommandInput,
} from './timerCommands';
import { AccessLevel } from './users';
import { makeMockConnection, makeMockPool } from '../test-utils/mockMysqlPool';

beforeEach(() => {
  vi.clearAllMocks();
});

const sampleInput: TimerCommandInput = {
  name: 'Discord plug',
  message: 'Join our Discord!',
  intervalSeconds: 600,
  minMessages: 5,
  requireLive: true,
  enabled: true,
};

describe('getAllTimerCommandsWithAssignments', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makeMockPool() as any);
    const result = await getAllTimerCommandsWithAssignments();
    expect(result).toEqual([]);
  });

  it('maps a timer row with no assigned users (null assigned_discord_id)', async () => {
    const row = {
      id: 1, name: 'Discord plug', message: 'Join!', interval_seconds: 600, min_messages: 0,
      require_live: 1, enabled: 1, assigned_discord_id: null, user_discord_id: null,
      discord_name: null, twitch_name: null, access_level: 0,
    };
    const pool = makeMockPool({ rows: [row] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllTimerCommandsWithAssignments();
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Discord plug');
    expect(result[0]!.assigned_users).toHaveLength(0);
    expect(result[0]!.require_live).toBe(true);
    expect(result[0]!.enabled).toBe(true);
  });

  it('groups multiple rows for the same timer into one entry with multiple assigned users', async () => {
    const rows = [
      {
        id: 1, name: 'Discord plug', message: 'Join!', interval_seconds: 600, min_messages: 0,
        require_live: 1, enabled: 1, assigned_discord_id: 'u1', user_discord_id: 'u1',
        discord_name: 'Alice', twitch_name: 'alice', access_level: 0,
      },
      {
        id: 1, name: 'Discord plug', message: 'Join!', interval_seconds: 600, min_messages: 0,
        require_live: 1, enabled: 1, assigned_discord_id: 'u2', user_discord_id: 'u2',
        discord_name: 'Bob', twitch_name: 'bob', access_level: 1,
      },
    ];
    const pool = makeMockPool({ rows });
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllTimerCommandsWithAssignments();
    expect(result).toHaveLength(1);
    expect(result[0]!.assigned_users).toHaveLength(2);
    expect(result[0]!.assigned_users[0]!.discord_id).toBe('u1');
    expect(result[0]!.assigned_users[1]!.discord_id).toBe('u2');
  });

  it('handles multiple distinct timers', async () => {
    const rows = [
      {
        id: 1, name: 'Plug', message: 'Join!', interval_seconds: 600, min_messages: 0,
        require_live: 1, enabled: 1, assigned_discord_id: null, user_discord_id: null,
        discord_name: null, twitch_name: null, access_level: 0,
      },
      {
        id: 2, name: 'Reminder', message: 'Sub!', interval_seconds: 900, min_messages: 0,
        require_live: 0, enabled: 0, assigned_discord_id: null, user_discord_id: null,
        discord_name: null, twitch_name: null, access_level: 0,
      },
    ];
    const pool = makeMockPool({ rows });
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllTimerCommandsWithAssignments();
    expect(result).toHaveLength(2);
    expect(result[1]!.enabled).toBe(false);
  });

  it('marks user as orphaned when user_discord_id is null, falling back access_level to USER', async () => {
    const row = {
      id: 1, name: 'Plug', message: 'Join!', interval_seconds: 600, min_messages: 0,
      require_live: 1, enabled: 1, assigned_discord_id: 'orphan1', user_discord_id: null,
      discord_name: null, twitch_name: null, access_level: null,
    };
    const pool = makeMockPool({ rows: [row] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllTimerCommandsWithAssignments();
    expect(result[0]!.assigned_users[0]!.is_orphaned_user).toBe(true);
    expect(result[0]!.assigned_users[0]!.access_level).toBe(AccessLevel.USER);
  });

  it('marks user as not orphaned when user_discord_id matches', async () => {
    const row = {
      id: 1, name: 'Plug', message: 'Join!', interval_seconds: 600, min_messages: 0,
      require_live: 1, enabled: 1, assigned_discord_id: 'u1', user_discord_id: 'u1',
      discord_name: 'Alice', twitch_name: 'alice', access_level: 0,
    };
    const pool = makeMockPool({ rows: [row] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllTimerCommandsWithAssignments();
    expect(result[0]!.assigned_users[0]!.is_orphaned_user).toBe(false);
  });
});

describe('addTimerCommand', () => {
  it('inserts and returns the new insertId', async () => {
    const pool = makeMockPool({ executeResult: [{ insertId: 42 }] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    const id = await addTimerCommand(sampleInput);
    expect(id).toBe(42);
    expect(pool.execute.mock.calls[0]![1]).toEqual(['Discord plug', 'Join our Discord!', 600, 5, 1, 1]);
  });
});

describe('updateTimerCommand', () => {
  it('updates when a row matched', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(updateTimerCommand(1, sampleInput)).resolves.toBeUndefined();
    expect(pool.execute.mock.calls[0]![1]).toEqual(['Discord plug', 'Join our Discord!', 600, 5, 1, 1, 1]);
    // affectedRows > 0 already proves the row exists — no need for a follow-up existence check.
    expect(pool.execute).toHaveBeenCalledTimes(1);
  });

  it('does not throw when affectedRows is 0 but the row exists unchanged (a resubmitted, identical edit)', async () => {
    const pool = makeMockPool();
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // the UPDATE itself: no-op, every value already equal
      .mockResolvedValueOnce([[{ 1: 1 }]]); // the existence check: row is still there
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(updateTimerCommand(1, sampleInput)).resolves.toBeUndefined();
  });

  it('throws TimerCommandNotFoundError when no row matched', async () => {
    const pool = makeMockPool();
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // the UPDATE itself: nothing matched
      .mockResolvedValueOnce([[]]); // the existence check: confirms the row is genuinely absent
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(updateTimerCommand(999, sampleInput)).rejects.toThrow(TimerCommandNotFoundError);
  });
});

describe('removeTimerCommand', () => {
  it('deletes scoped to id', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await removeTimerCommand(1);
    expect(pool.execute.mock.calls[0]![1]).toEqual([1]);
  });

  it('no-ops without throwing when nothing matched', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 0 }] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(removeTimerCommand(999)).resolves.toBeUndefined();
  });
});

describe('setTimerCommandEnabled', () => {
  it('updates the enabled flag when a row matched', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await setTimerCommandEnabled(1, false);
    expect(pool.execute.mock.calls[0]![1]).toEqual([0, 1]);
  });

  it('does not throw when affectedRows is 0 but the row exists already in the requested state', async () => {
    const pool = makeMockPool();
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // the UPDATE itself: no-op, already in that state
      .mockResolvedValueOnce([[{ 1: 1 }]]); // the existence check: row is still there
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(setTimerCommandEnabled(1, true)).resolves.toBeUndefined();
  });

  it('throws TimerCommandNotFoundError when no row matched', async () => {
    const pool = makeMockPool();
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // the UPDATE itself: nothing matched
      .mockResolvedValueOnce([[]]); // the existence check: confirms the row is genuinely absent
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(setTimerCommandEnabled(999, true)).rejects.toThrow(TimerCommandNotFoundError);
  });
});

describe('assignUserToTimer', () => {
  it('inserts an assignment row, tolerating a duplicate via the no-op upsert', async () => {
    const pool = makeMockPool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await assignUserToTimer(1, 'u1');
    expect(pool.execute.mock.calls[0]![1]).toEqual([1, 'u1']);
  });
});

describe('assignUsersToTimer', () => {
  it('is a no-op when discordIds is empty', async () => {
    const pool = makeMockPool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await assignUsersToTimer(1, []);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('inserts one row per discord id in a single statement', async () => {
    const pool = makeMockPool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await assignUsersToTimer(1, ['u1', 'u2']);
    expect(pool.execute).toHaveBeenCalledTimes(1);
    expect(pool.execute.mock.calls[0]![0]).toContain('VALUES (?, ?), (?, ?) AS new_row');
    expect(pool.execute.mock.calls[0]![1]).toEqual([1, 'u1', 1, 'u2']);
  });
});

describe('unassignUserFromTimer', () => {
  it('deletes scoped to timer id and discord id', async () => {
    const pool = makeMockPool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await unassignUserFromTimer(1, 'u1');
    expect(pool.execute.mock.calls[0]![1]).toEqual([1, 'u1']);
  });
});

describe('getAllEnabledTimerCommandsWithChannel', () => {
  it('maps joined rows to scheduler shape', async () => {
    const joinedRow = {
      id: 1,
      channel: 'somestreamer',
      message: 'Join our Discord!',
      interval_seconds: 600,
      min_messages: 5,
      require_live: 1,
    };
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows: [joinedRow] }) as any);
    const rows = await getAllEnabledTimerCommandsWithChannel();
    expect(rows).toEqual([{
      id: 1,
      channel: 'somestreamer',
      message: 'Join our Discord!',
      interval_seconds: 600,
      min_messages: 5,
      require_live: true,
    }]);
  });

  it('returns one row per assigned channel when a timer has multiple assignments', async () => {
    const rows = [
      { id: 1, channel: 'streamer_a', message: 'hi', interval_seconds: 600, min_messages: 0, require_live: 1 },
      { id: 1, channel: 'streamer_b', message: 'hi', interval_seconds: 600, min_messages: 0, require_live: 1 },
    ];
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows }) as any);
    const result = await getAllEnabledTimerCommandsWithChannel();
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.channel)).toEqual(['streamer_a', 'streamer_b']);
  });

  it('queries with no parameters (filtering happens in SQL)', async () => {
    const pool = makeMockPool({ rows: [] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getAllEnabledTimerCommandsWithChannel();
    expect(pool.execute.mock.calls[0]![1]).toBeUndefined();
  });

  it('normalizes the channel so it matches the lowercased key chat activity is recorded under', async () => {
    // If this returned the raw stored value unnormalized, a channel with any uppercase
    // characters would produce a `row.channel` that never matches the lowercase key
    // `recordChatMessage` stores counts under — silently and permanently blocking
    // `min_messages` with no error, since a message-count miss looks identical to "no chat yet."
    const joinedRow = {
      id: 1, channel: 'SomeStreamer', message: 'hi', interval_seconds: 600, min_messages: 0, require_live: 1,
    };
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows: [joinedRow] }) as any);
    const rows = await getAllEnabledTimerCommandsWithChannel();
    expect(rows).toEqual([expect.objectContaining({ channel: 'somestreamer' })]);
  });

  it('drops a row whose stored channel fails to normalize', async () => {
    const rows = [
      { id: 1, channel: 'validname', message: 'hi', interval_seconds: 600, min_messages: 0, require_live: 1 },
      { id: 2, channel: 'x', message: 'hi', interval_seconds: 600, min_messages: 0, require_live: 1 }, // too short to be a valid channel name
    ];
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows }) as any);
    const result = await getAllEnabledTimerCommandsWithChannel();
    expect(result.map((r) => r.id)).toEqual([1]);
  });
});

// ─── Streamer self-service ───────────────────────────────────────────────────

describe('owner-checked timer writes', () => {
  const STREAMER_ID = '111111111111111111';
  const OTHER_ID = '222222222222222222';

  /** A fake pool whose connection returns the timer row (or none), then its assignment rows, then a write result. */
  function poolWithTimer(exists: boolean, assignedIds: string[]) {
    const connection = makeMockConnection();
    connection.execute
      .mockResolvedValueOnce([exists ? [{ id: 7 }] : [], []])
      .mockResolvedValueOnce([assignedIds.map((discord_id) => ({ discord_id })), []])
      .mockResolvedValue([{ affectedRows: 1 }, []]);
    const pool = makeMockPool({ connection });
    vi.mocked(getPool).mockReturnValue(pool as any);
    return connection;
  }

  it('locks the timer and its assignments before an update, then writes and commits', async () => {
    const connection = poolWithTimer(true, [STREAMER_ID]);
    await updateOwnTimerCommand(7, sampleInput, STREAMER_ID);
    const sqls = connection.execute.mock.calls.map((call) => String(call[0]));
    expect(sqls[0]).toContain('FROM timer_command WHERE id = ? FOR UPDATE');
    expect(sqls[1]).toContain('FROM timer_command_streamer WHERE timer_id = ? FOR UPDATE');
    expect(sqls[2]).toContain('UPDATE timer_command');
    expect(connection.execute.mock.calls[2]![1]).toEqual(['Discord plug', 'Join our Discord!', 600, 5, 1, 1, 7]);
    expect(connection.commit).toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
  });

  it('denies an update on a shared timer and writes nothing', async () => {
    const connection = poolWithTimer(true, [STREAMER_ID, OTHER_ID]);
    await expect(updateOwnTimerCommand(7, sampleInput, STREAMER_ID)).rejects.toThrow('Timer not self-manageable: 7');
    expect(connection.execute).toHaveBeenCalledTimes(2);
    expect(connection.rollback).toHaveBeenCalled();
  });

  it('throws TimerCommandNotFoundError when the timer is gone', async () => {
    poolWithTimer(false, []);
    await expect(setOwnTimerCommandEnabled(7, true, STREAMER_ID)).rejects.toBeInstanceOf(TimerCommandNotFoundError);
  });

  it('toggles a timer the streamer owns outright', async () => {
    const connection = poolWithTimer(true, [STREAMER_ID]);
    await setOwnTimerCommandEnabled(7, false, STREAMER_ID);
    expect(connection.execute.mock.calls[2]).toEqual(['UPDATE timer_command SET enabled = ? WHERE id = ?', [0, 7]]);
  });

  it('deletes a timer the streamer owns outright, but not someone else\'s', async () => {
    const owned = poolWithTimer(true, [STREAMER_ID]);
    await removeOwnTimerCommand(7, STREAMER_ID);
    expect(owned.execute.mock.calls[2]).toEqual(['DELETE FROM timer_command WHERE id = ?', [7]]);

    const other = poolWithTimer(true, [OTHER_ID]);
    await expect(removeOwnTimerCommand(7, STREAMER_ID)).rejects.toThrow('Timer not self-manageable: 7');
    expect(other.execute).toHaveBeenCalledTimes(2);
  });

  it('discards a just-created timer with no assignees yet, but leaves one a Mod has adopted', async () => {
    const unclaimed = poolWithTimer(true, []);
    await discardOwnNewTimerCommand(7, STREAMER_ID);
    expect(unclaimed.execute.mock.calls[2]).toEqual(['DELETE FROM timer_command WHERE id = ?', [7]]);

    const adopted = poolWithTimer(true, [OTHER_ID]);
    await expect(discardOwnNewTimerCommand(7, STREAMER_ID)).rejects.toThrow('Timer not self-manageable: 7');
    expect(adopted.execute).toHaveBeenCalledTimes(2);
  });
});
