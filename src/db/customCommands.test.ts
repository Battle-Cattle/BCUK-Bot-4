import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

/** Mocks the shared logger so this module's log calls don't produce real output during tests. */
vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));
vi.mock('./commandLocks', () => ({
  acquireNamedLock: vi.fn().mockResolvedValue(undefined),
  releaseNamedLock: vi.fn().mockResolvedValue(undefined),
  commandExists: vi.fn().mockResolvedValue(false),
  runSerializedCommandWrite: vi.fn(),
}));
vi.mock('./commandConflicts', () => ({
  assertDiscordTriggerAvailable: vi.fn().mockResolvedValue(undefined),
  assertMultiTwitchTriggerAvailable: vi.fn().mockResolvedValue(undefined),
  assertNoSingleTwitchAssignmentOverlap: vi.fn().mockResolvedValue(undefined),
  assignUserToCommandWithinTransaction: vi.fn().mockResolvedValue(undefined),
  assignUsersToCommandWithinTransaction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./reservedCommands', () => ({
  assertNotReservedCommand: vi.fn(),
}));
vi.mock('./commandStringUtils', () => ({
  requireTrimmedString: vi.fn((s: string) => (s ? s.trim() : '')),
  CommandNotFoundError: class CommandNotFoundError extends Error {
    id: number;
    constructor(id: number) { super(`Command not found: ${id}`); this.id = id; }
  },
}));

import { getPool } from './pool';
import {
  getAllCustomCommandsWithAssignments,
  getCustomCommandCount,
  addCustomCommand,
  updateCustomCommand,
  removeCustomCommand,
  assignUserToCommand,
  assignUsersToCommand,
  unassignUserFromCommand,
} from './customCommands';
import { runSerializedCommandWrite, acquireNamedLock, releaseNamedLock } from './commandLocks';
import {
  assertDiscordTriggerAvailable,
  assertMultiTwitchTriggerAvailable,
  assertNoSingleTwitchAssignmentOverlap,
  assignUserToCommandWithinTransaction,
  assignUsersToCommandWithinTransaction,
} from './commandConflicts';
import { assertNotReservedCommand } from './reservedCommands';
import { makeMockPool } from '../test-utils/mockMysqlPool';

/** Builds a fake mysql pool with default (empty-row) `execute`/`query` behaviour. */
function makePool() {
  return makeMockPool();
}

/**
 * Builds a fake write connection that replays a queue of results by call index (falling back to
 * a generic success result) rather than the strict per-call `mockResolvedValueOnce` chaining the
 * shared helper assumes, so it's kept local instead of being folded into makeMockConnection.
 */
function makeWriteConn(executeResults: unknown[] = []) {
  let callIndex = 0;
  return {
    execute: vi.fn().mockImplementation(() => {
      const result = executeResults[callIndex] ?? [{ affectedRows: 1 }, []];
      callIndex++;
      return Promise.resolve(result);
    }),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getCustomCommandCount ─────────────────────────────────────────────────────

describe('getCustomCommandCount', () => {
  it('returns the count from the query result', async () => {
    const pool = makePool();
    pool.execute.mockResolvedValue([[{ count: 12 }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await getCustomCommandCount()).toBe(12);
  });
});

// ─── getAllCustomCommandsWithAssignments ──────────────────────────────────────

describe('getAllCustomCommandsWithAssignments', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    const result = await getAllCustomCommandsWithAssignments();
    expect(result).toEqual([]);
  });

  it('maps a command row with no assigned users (null assigned_discord_id)', async () => {
    const row = { command_id: 1, trigger_string: '!clap', output: 'Clap!', is_discord_enabled: 1, is_multi_twitch: 0, assigned_discord_id: null, user_discord_id: null, discord_name: null, twitch_name: null, access_level: 0, is_twitch_bot_enabled: 0 };
    const pool = makePool();
    pool.execute.mockResolvedValue([[row], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllCustomCommandsWithAssignments();
    expect(result).toHaveLength(1);
    expect(result[0].trigger_string).toBe('!clap');
    expect(result[0].assigned_users).toHaveLength(0);
    expect(result[0].is_discord_enabled).toBe(true);
    expect(result[0].is_multi_twitch).toBe(false);
  });

  it('groups multiple rows for the same command into one entry with multiple assigned users', async () => {
    const rows = [
      { command_id: 1, trigger_string: '!clap', output: 'Clap!', is_discord_enabled: 1, is_multi_twitch: 0, assigned_discord_id: 'u1', user_discord_id: 'u1', discord_name: 'Alice', twitch_name: 'alice', access_level: 0, is_twitch_bot_enabled: 1 },
      { command_id: 1, trigger_string: '!clap', output: 'Clap!', is_discord_enabled: 1, is_multi_twitch: 0, assigned_discord_id: 'u2', user_discord_id: 'u2', discord_name: 'Bob', twitch_name: 'bob', access_level: 1, is_twitch_bot_enabled: 0 },
    ];
    const pool = makePool();
    pool.execute.mockResolvedValue([rows, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllCustomCommandsWithAssignments();
    expect(result).toHaveLength(1);
    expect(result[0].assigned_users).toHaveLength(2);
    expect(result[0].assigned_users[0].discord_id).toBe('u1');
    expect(result[0].assigned_users[1].discord_id).toBe('u2');
  });

  it('handles multiple distinct commands', async () => {
    const rows = [
      { command_id: 1, trigger_string: '!clap', output: 'Clap!', is_discord_enabled: 1, is_multi_twitch: 0, assigned_discord_id: null, user_discord_id: null, discord_name: null, twitch_name: null, access_level: 0, is_twitch_bot_enabled: 0 },
      { command_id: 2, trigger_string: '!hug', output: 'Hug!', is_discord_enabled: 0, is_multi_twitch: 1, assigned_discord_id: null, user_discord_id: null, discord_name: null, twitch_name: null, access_level: 0, is_twitch_bot_enabled: 0 },
    ];
    const pool = makePool();
    pool.execute.mockResolvedValue([rows, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllCustomCommandsWithAssignments();
    expect(result).toHaveLength(2);
    expect(result[1].is_multi_twitch).toBe(true);
  });

  it('maps BIT(1) Buffer([1]) fields for is_discord_enabled and is_multi_twitch as true', async () => {
    const row = { command_id: 1, trigger_string: '!ok', output: 'ok', is_discord_enabled: Buffer.from([1]), is_multi_twitch: Buffer.from([1]), assigned_discord_id: null, user_discord_id: null, discord_name: null, twitch_name: null, access_level: 0, is_twitch_bot_enabled: 0 };
    const pool = makePool();
    pool.execute.mockResolvedValue([[row], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllCustomCommandsWithAssignments();
    expect(result[0].is_discord_enabled).toBe(true);
    expect(result[0].is_multi_twitch).toBe(true);
  });

  it('maps BIT(1) Buffer([0]) fields for is_discord_enabled and is_multi_twitch as false', async () => {
    const row = { command_id: 1, trigger_string: '!ok', output: 'ok', is_discord_enabled: Buffer.from([0]), is_multi_twitch: Buffer.from([0]), assigned_discord_id: null, user_discord_id: null, discord_name: null, twitch_name: null, access_level: 0, is_twitch_bot_enabled: 0 };
    const pool = makePool();
    pool.execute.mockResolvedValue([[row], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllCustomCommandsWithAssignments();
    expect(result[0].is_discord_enabled).toBe(false);
    expect(result[0].is_multi_twitch).toBe(false);
  });

  it('maps null fields for is_discord_enabled and is_multi_twitch as false', async () => {
    const row = { command_id: 1, trigger_string: '!ok', output: 'ok', is_discord_enabled: null, is_multi_twitch: null, assigned_discord_id: null, user_discord_id: null, discord_name: null, twitch_name: null, access_level: 0, is_twitch_bot_enabled: 0 };
    const pool = makePool();
    pool.execute.mockResolvedValue([[row], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllCustomCommandsWithAssignments();
    expect(result[0].is_discord_enabled).toBe(false);
    expect(result[0].is_multi_twitch).toBe(false);
  });

  it('marks user as orphaned when user_discord_id is null', async () => {
    const row = { command_id: 1, trigger_string: '!clap', output: 'Clap!', is_discord_enabled: 0, is_multi_twitch: 0, assigned_discord_id: 'orphan1', user_discord_id: null, discord_name: null, twitch_name: null, access_level: 0, is_twitch_bot_enabled: 0 };
    const pool = makePool();
    pool.execute.mockResolvedValue([[row], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllCustomCommandsWithAssignments();
    expect(result[0].assigned_users[0].is_orphaned_user).toBe(true);
  });

  it('marks user as not orphaned when user_discord_id matches', async () => {
    const row = { command_id: 1, trigger_string: '!clap', output: 'Clap!', is_discord_enabled: 0, is_multi_twitch: 0, assigned_discord_id: 'u1', user_discord_id: 'u1', discord_name: 'Alice', twitch_name: 'alice', access_level: 0, is_twitch_bot_enabled: 0 };
    const pool = makePool();
    pool.execute.mockResolvedValue([[row], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllCustomCommandsWithAssignments();
    expect(result[0].assigned_users[0].is_orphaned_user).toBe(false);
  });
});

// ─── addCustomCommand ─────────────────────────────────────────────────────────

describe('addCustomCommand', () => {
  function setupRunSerializedCommandWrite(conn: ReturnType<typeof makeWriteConn>) {
    vi.mocked(runSerializedCommandWrite).mockImplementation(async (_cmds, _opts, writeFn) => writeFn(conn as any));
  }

  it('calls assertNotReservedCommand with the normalized trigger', async () => {
    const conn = makeWriteConn([[{ insertId: 5 }, []]]);
    setupRunSerializedCommandWrite(conn);
    await addCustomCommand('!clap', 'Clap!', false, false);
    expect(assertNotReservedCommand).toHaveBeenCalledWith('!clap');
  });

  it('returns the insertId from the INSERT query', async () => {
    const conn = makeWriteConn([[{ insertId: 42 }, []]]);
    setupRunSerializedCommandWrite(conn);
    const id = await addCustomCommand('!clap', 'Clap!', false, false);
    expect(id).toBe(42);
  });

  it('calls assertDiscordTriggerAvailable when isDiscordEnabled=true', async () => {
    const conn = makeWriteConn([[{ insertId: 1 }, []]]);
    setupRunSerializedCommandWrite(conn);
    await addCustomCommand('!clap', 'Clap!', true, false);
    expect(assertDiscordTriggerAvailable).toHaveBeenCalledWith('!clap', conn);
  });

  it('does NOT call assertDiscordTriggerAvailable when isDiscordEnabled=false', async () => {
    const conn = makeWriteConn([[{ insertId: 1 }, []]]);
    setupRunSerializedCommandWrite(conn);
    await addCustomCommand('!clap', 'Clap!', false, false);
    expect(assertDiscordTriggerAvailable).not.toHaveBeenCalled();
  });

  it('calls assertMultiTwitchTriggerAvailable when isMultiTwitch=true', async () => {
    const conn = makeWriteConn([[{ insertId: 1 }, []]]);
    setupRunSerializedCommandWrite(conn);
    await addCustomCommand('!clap', 'Clap!', false, true);
    expect(assertMultiTwitchTriggerAvailable).toHaveBeenCalledWith(conn, '!clap');
  });

  it('does NOT call assertMultiTwitchTriggerAvailable when isMultiTwitch=false', async () => {
    const conn = makeWriteConn([[{ insertId: 1 }, []]]);
    setupRunSerializedCommandWrite(conn);
    await addCustomCommand('!clap', 'Clap!', false, false);
    expect(assertMultiTwitchTriggerAvailable).not.toHaveBeenCalled();
  });

  it('propagates errors from assertNotReservedCommand', async () => {
    vi.mocked(assertNotReservedCommand).mockImplementationOnce(() => { throw new Error('Reserved!'); });
    await expect(addCustomCommand('!sfx', 'output', false, false)).rejects.toThrow('Reserved!');
  });
});

// ─── updateCustomCommand ──────────────────────────────────────────────────────

describe('updateCustomCommand', () => {
  function setupRunSerializedCommandWrite(conn: ReturnType<typeof makeWriteConn>) {
    vi.mocked(runSerializedCommandWrite).mockImplementation(async (_cmds, _opts, writeFn) => writeFn(conn as any));
  }

  it('calls assertDiscordTriggerAvailable with excludeCommandId when isDiscordEnabled=true', async () => {
    const conn = makeWriteConn([[{ affectedRows: 1 }, []]]);
    setupRunSerializedCommandWrite(conn);
    await updateCustomCommand(7, '!clap', 'Clap!', true, false);
    expect(assertDiscordTriggerAvailable).toHaveBeenCalledWith('!clap', conn, 7);
  });

  it('calls assertMultiTwitchTriggerAvailable with excludeCommandId when isMultiTwitch=true', async () => {
    const conn = makeWriteConn([[{ affectedRows: 1 }, []]]);
    setupRunSerializedCommandWrite(conn);
    await updateCustomCommand(7, '!clap', 'Clap!', false, true);
    expect(assertMultiTwitchTriggerAvailable).toHaveBeenCalledWith(conn, '!clap', 7);
  });

  it('calls assertNoSingleTwitchAssignmentOverlap when isMultiTwitch=false', async () => {
    const conn = makeWriteConn([[{ affectedRows: 1 }, []]]);
    setupRunSerializedCommandWrite(conn);
    await updateCustomCommand(7, '!clap', 'Clap!', false, false);
    expect(assertNoSingleTwitchAssignmentOverlap).toHaveBeenCalledWith(conn, 7, '!clap');
  });

  it('throws CommandNotFoundError when affectedRows=0 and command does not exist', async () => {
    const conn = makeWriteConn([[{ affectedRows: 0 }, []]]);
    setupRunSerializedCommandWrite(conn);
    // commandExists returns false by default (mock)
    await expect(updateCustomCommand(99, '!clap', 'Clap!', false, false)).rejects.toThrow('Command not found: 99');
  });

});

// ─── removeCustomCommand ──────────────────────────────────────────────────────

describe('removeCustomCommand', () => {
  it('acquires lock, begins transaction, deletes assignments and command, commits', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])  // DELETE twitch_user_commands
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);  // DELETE custom_command
    vi.mocked(getPool).mockReturnValue(pool as any);
    await removeCustomCommand(5);
    expect(acquireNamedLock).toHaveBeenCalledWith(conn, 'bcuk_cmdid_5');
    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
    expect(releaseNamedLock).toHaveBeenCalledWith(conn, 'bcuk_cmdid_5');
  });

  it('throws CommandNotFoundError when DELETE affects 0 rows', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])  // DELETE twitch_user_commands
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);  // DELETE custom_command — not found
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(removeCustomCommand(99)).rejects.toThrow('Command not found: 99');
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('releases connection even when an error is thrown', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute.mockRejectedValue(new Error('DB error'));
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(removeCustomCommand(1)).rejects.toThrow('DB error');
    expect(conn.release).toHaveBeenCalled();
    expect(releaseNamedLock).toHaveBeenCalled();
  });
});

// ─── assignUserToCommand ──────────────────────────────────────────────────────

describe('assignUserToCommand', () => {
  it('acquires lock, calls assignUserToCommandWithinTransaction, releases lock and connection', async () => {
    const pool = makePool();
    const conn = pool._conn;
    vi.mocked(getPool).mockReturnValue(pool as any);
    await assignUserToCommand(3, 'user1');
    expect(acquireNamedLock).toHaveBeenCalledWith(conn, 'bcuk_cmdid_3');
    expect(assignUserToCommandWithinTransaction).toHaveBeenCalledWith(conn, 3, 'user1');
    expect(releaseNamedLock).toHaveBeenCalledWith(conn, 'bcuk_cmdid_3');
    expect(conn.release).toHaveBeenCalled();
  });

  it('releases lock and connection even when assignUserToCommandWithinTransaction throws', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    vi.mocked(assignUserToCommandWithinTransaction).mockRejectedValueOnce(new Error('conflict'));
    await expect(assignUserToCommand(3, 'user1')).rejects.toThrow('conflict');
    expect(releaseNamedLock).toHaveBeenCalled();
    expect(pool._conn.release).toHaveBeenCalled();
  });
});

// ─── assignUsersToCommand ──────────────────────────────────────────────────────

describe('assignUsersToCommand', () => {
  it('no-ops without opening a connection when discordIds is empty', async () => {
    vi.mocked(getPool).mockClear();
    await assignUsersToCommand(3, []);
    expect(getPool).not.toHaveBeenCalled();
    expect(assignUsersToCommandWithinTransaction).not.toHaveBeenCalled();
  });

  it('acquires lock once, calls assignUsersToCommandWithinTransaction with all ids, releases lock and connection', async () => {
    const pool = makePool();
    const conn = pool._conn;
    vi.mocked(getPool).mockReturnValue(pool as any);
    await assignUsersToCommand(3, ['user1', 'user2']);
    expect(acquireNamedLock).toHaveBeenCalledTimes(1);
    expect(acquireNamedLock).toHaveBeenCalledWith(conn, 'bcuk_cmdid_3');
    expect(assignUsersToCommandWithinTransaction).toHaveBeenCalledWith(conn, 3, ['user1', 'user2']);
    expect(releaseNamedLock).toHaveBeenCalledWith(conn, 'bcuk_cmdid_3');
    expect(conn.release).toHaveBeenCalled();
  });

  it('releases lock and connection even when assignUsersToCommandWithinTransaction throws', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    vi.mocked(assignUsersToCommandWithinTransaction).mockRejectedValueOnce(new Error('conflict'));
    await expect(assignUsersToCommand(3, ['user1'])).rejects.toThrow('conflict');
    expect(releaseNamedLock).toHaveBeenCalled();
    expect(pool._conn.release).toHaveBeenCalled();
  });
});

// ─── unassignUserFromCommand ──────────────────────────────────────────────────

describe('unassignUserFromCommand', () => {
  it('executes DELETE with commandId and discordId', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await unassignUserFromCommand(4, 'user2');
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM twitch_user_commands');
    expect(params).toContain(4);
    expect(params).toContain('user2');
  });
});
