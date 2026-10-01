import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

/** Mocks the shared logger so this module's log calls don't produce real output during tests. */
vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
// `runInTransaction` is reimplemented here (rather than via `importOriginal`) so this test
// doesn't pull in pool.ts's real `../shared/config` import chain, which throws in a test
// environment with no DISCORD_TOKEN etc. set. The logic mirrors pool.ts's real implementation
// exactly, driven by the connection `removeCustomCommand` acquires from the mocked `getPool()`.
vi.mock('./pool', () => ({
  getPool: vi.fn(),
  runInTransaction: async (conn: { beginTransaction: () => Promise<void>; commit: () => Promise<void>; rollback: () => Promise<void> }, work: () => Promise<unknown>) => {
    try {
      await conn.beginTransaction();
      const result = await work();
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    }
  },
}));
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
  CommandSelfServiceDeniedError: class CommandSelfServiceDeniedError extends Error {
    constructor(id: number) { super(`Command not self-manageable: ${id}`); }
  },
}));

import { getPool } from './pool';
import {
  getAllCustomCommandsWithAssignments,
  getCustomCommandCount,
  addCustomCommand,
  updateCustomCommand,
  removeCustomCommand,
  updateOwnCustomCommand,
  removeOwnCustomCommand,
  discardOwnNewCustomCommand,
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
    expect(result[0]!.trigger_string).toBe('!clap');
    expect(result[0]!.assigned_users).toHaveLength(0);
    expect(result[0]!.is_discord_enabled).toBe(true);
    expect(result[0]!.is_multi_twitch).toBe(false);
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
    expect(result[0]!.assigned_users).toHaveLength(2);
    expect(result[0]!.assigned_users[0]!.discord_id).toBe('u1');
    expect(result[0]!.assigned_users[1]!.discord_id).toBe('u2');
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
    expect(result[1]!.is_multi_twitch).toBe(true);
  });

  it('maps BIT(1) Buffer([1]) fields for is_discord_enabled and is_multi_twitch as true', async () => {
    const row = { command_id: 1, trigger_string: '!ok', output: 'ok', is_discord_enabled: Buffer.from([1]), is_multi_twitch: Buffer.from([1]), assigned_discord_id: null, user_discord_id: null, discord_name: null, twitch_name: null, access_level: 0, is_twitch_bot_enabled: 0 };
    const pool = makePool();
    pool.execute.mockResolvedValue([[row], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllCustomCommandsWithAssignments();
    expect(result[0]!.is_discord_enabled).toBe(true);
    expect(result[0]!.is_multi_twitch).toBe(true);
  });

  it('maps BIT(1) Buffer([0]) fields for is_discord_enabled and is_multi_twitch as false', async () => {
    const row = { command_id: 1, trigger_string: '!ok', output: 'ok', is_discord_enabled: Buffer.from([0]), is_multi_twitch: Buffer.from([0]), assigned_discord_id: null, user_discord_id: null, discord_name: null, twitch_name: null, access_level: 0, is_twitch_bot_enabled: 0 };
    const pool = makePool();
    pool.execute.mockResolvedValue([[row], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllCustomCommandsWithAssignments();
    expect(result[0]!.is_discord_enabled).toBe(false);
    expect(result[0]!.is_multi_twitch).toBe(false);
  });

  it('maps null fields for is_discord_enabled and is_multi_twitch as false', async () => {
    const row = { command_id: 1, trigger_string: '!ok', output: 'ok', is_discord_enabled: null, is_multi_twitch: null, assigned_discord_id: null, user_discord_id: null, discord_name: null, twitch_name: null, access_level: 0, is_twitch_bot_enabled: 0 };
    const pool = makePool();
    pool.execute.mockResolvedValue([[row], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllCustomCommandsWithAssignments();
    expect(result[0]!.is_discord_enabled).toBe(false);
    expect(result[0]!.is_multi_twitch).toBe(false);
  });

  it('marks user as orphaned when user_discord_id is null', async () => {
    const row = { command_id: 1, trigger_string: '!clap', output: 'Clap!', is_discord_enabled: 0, is_multi_twitch: 0, assigned_discord_id: 'orphan1', user_discord_id: null, discord_name: null, twitch_name: null, access_level: 0, is_twitch_bot_enabled: 0 };
    const pool = makePool();
    pool.execute.mockResolvedValue([[row], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllCustomCommandsWithAssignments();
    expect(result[0]!.assigned_users[0]!.is_orphaned_user).toBe(true);
  });

  it('marks user as not orphaned when user_discord_id matches', async () => {
    const row = { command_id: 1, trigger_string: '!clap', output: 'Clap!', is_discord_enabled: 0, is_multi_twitch: 0, assigned_discord_id: 'u1', user_discord_id: 'u1', discord_name: 'Alice', twitch_name: 'alice', access_level: 0, is_twitch_bot_enabled: 0 };
    const pool = makePool();
    pool.execute.mockResolvedValue([[row], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllCustomCommandsWithAssignments();
    expect(result[0]!.assigned_users[0]!.is_orphaned_user).toBe(false);
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

  it("holds the command's id lock on its own connection around the trigger-locked write, so a concurrent assignment can't validate a stale trigger", async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    const order: string[] = [];
    vi.mocked(acquireNamedLock).mockImplementationOnce(async (_conn, name) => { order.push(`acquire:${name}`); });
    vi.mocked(releaseNamedLock).mockImplementationOnce(async (_conn, name) => { order.push(`release:${name}`); });
    vi.mocked(runSerializedCommandWrite).mockImplementationOnce(async () => { order.push('write'); });

    await updateCustomCommand(7, '!clap', 'Clap!', false, false);

    expect(order).toEqual(['acquire:bcuk_cmdid_7', 'write', 'release:bcuk_cmdid_7']);
    expect(vi.mocked(acquireNamedLock).mock.calls[0]![0]).toBe(pool._conn);
    // The trigger-locked write reuses the id-lock connection instead of taking a second one.
    expect(vi.mocked(runSerializedCommandWrite).mock.calls[0]![1]).toMatchObject({ excludeCustomCommandId: 7, connection: pool._conn });
    expect(pool.getConnection).toHaveBeenCalledTimes(1);
    expect(pool._conn.release).toHaveBeenCalled();
  });

  it('releases the id lock and connection even when the write fails', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    vi.mocked(runSerializedCommandWrite).mockRejectedValueOnce(new Error('conflict'));

    await expect(updateCustomCommand(7, '!clap', 'Clap!', false, false)).rejects.toThrow('conflict');

    expect(releaseNamedLock).toHaveBeenCalledWith(pool._conn, 'bcuk_cmdid_7');
    expect(pool._conn.release).toHaveBeenCalled();
  });

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

const STREAMER_ID = '111111111111111111';
const OTHER_ID = '222222222222222222';

/** `SELECT … FOR UPDATE` results for the locked ownership check: the command row, then its assignment rows. */
function ownershipRows(flags: { is_discord_enabled: number; is_multi_twitch: number } | null, assignees: string[]) {
  return [
    [flags ? [flags] : [], []],
    [assignees.map((discord_id) => ({ discord_id })), []],
  ];
}

describe('updateOwnCustomCommand', () => {
  function setupRunSerializedCommandWrite(conn: ReturnType<typeof makeWriteConn>) {
    vi.mocked(runSerializedCommandWrite).mockImplementation(async (_cmds, _opts, writeFn) => writeFn(conn as any));
  }

  it('locks the command and assignment rows, then writes a Twitch-only update when the streamer owns it outright', async () => {
    const conn = makeWriteConn([...ownershipRows({ is_discord_enabled: 0, is_multi_twitch: 0 }, [STREAMER_ID]), [{ affectedRows: 1 }, []]]);
    setupRunSerializedCommandWrite(conn);

    await updateOwnCustomCommand(7, '!clap', 'Clap!', STREAMER_ID);

    expect(conn.execute.mock.calls[0]![0]).toMatch(/FROM custom_command WHERE command_id = \? FOR UPDATE/);
    expect(conn.execute.mock.calls[1]![0]).toMatch(/FROM twitch_user_commands WHERE command_id = \? FOR UPDATE/);
    expect(conn.execute.mock.calls[2]![0]).toContain('UPDATE custom_command');
    expect(conn.execute.mock.calls[2]![1]).toEqual(['!clap', 'Clap!', 0, 0, 7]);
  });

  it.each([
    ['shared with another channel', { is_discord_enabled: 0, is_multi_twitch: 0 }, [STREAMER_ID, OTHER_ID]],
    ['assigned to someone else', { is_discord_enabled: 0, is_multi_twitch: 0 }, [OTHER_ID]],
    ['Discord-enabled', { is_discord_enabled: 1, is_multi_twitch: 0 }, [STREAMER_ID]],
    ['multi-Twitch', { is_discord_enabled: 0, is_multi_twitch: 1 }, [STREAMER_ID]],
  ])('throws CommandSelfServiceDeniedError without writing when the command is %s', async (_label, flags, assignees) => {
    const conn = makeWriteConn(ownershipRows(flags, assignees));
    setupRunSerializedCommandWrite(conn);

    await expect(updateOwnCustomCommand(7, '!clap', 'Clap!', STREAMER_ID)).rejects.toThrow('Command not self-manageable: 7');
    expect(conn.execute).toHaveBeenCalledTimes(2);
  });

  it('throws CommandNotFoundError when the command row is gone', async () => {
    const conn = makeWriteConn(ownershipRows(null, []));
    setupRunSerializedCommandWrite(conn);

    await expect(updateOwnCustomCommand(7, '!clap', 'Clap!', STREAMER_ID)).rejects.toThrow('Command not found: 7');
    expect(conn.execute).toHaveBeenCalledTimes(1);
  });
});

describe('removeOwnCustomCommand', () => {
  it('deletes, under the id lock and transaction, a command the streamer owns outright', async () => {
    const pool = makePool();
    const conn = pool._conn;
    for (const result of ownershipRows({ is_discord_enabled: 0, is_multi_twitch: 0 }, [STREAMER_ID])) {
      conn.execute.mockResolvedValueOnce(result);
    }
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])  // DELETE twitch_user_commands
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);  // DELETE custom_command
    vi.mocked(getPool).mockReturnValue(pool as any);

    await removeOwnCustomCommand(5, STREAMER_ID);

    expect(acquireNamedLock).toHaveBeenCalledWith(conn, 'bcuk_cmdid_5');
    expect(conn.execute.mock.calls[0]![0]).toContain('FOR UPDATE');
    expect(conn.execute.mock.calls[3]![0]).toContain('DELETE FROM custom_command');
    expect(conn.commit).toHaveBeenCalled();
  });

  it('deletes nothing and rolls back when the command is shared', async () => {
    const pool = makePool();
    const conn = pool._conn;
    for (const result of ownershipRows({ is_discord_enabled: 0, is_multi_twitch: 0 }, [STREAMER_ID, OTHER_ID])) {
      conn.execute.mockResolvedValueOnce(result);
    }
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(removeOwnCustomCommand(5, STREAMER_ID)).rejects.toThrow('Command not self-manageable: 5');
    expect(conn.execute).toHaveBeenCalledTimes(2);
    expect(conn.rollback).toHaveBeenCalled();
    expect(releaseNamedLock).toHaveBeenCalledWith(conn, 'bcuk_cmdid_5');
  });
});

describe('discardOwnNewCustomCommand', () => {
  it('deletes the new command when it is still unclaimed (the failed assignment left no assignees)', async () => {
    const pool = makePool();
    const conn = pool._conn;
    for (const result of ownershipRows({ is_discord_enabled: 0, is_multi_twitch: 0 }, [])) {
      conn.execute.mockResolvedValueOnce(result);
    }
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])  // DELETE twitch_user_commands
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);  // DELETE custom_command
    vi.mocked(getPool).mockReturnValue(pool as any);

    await discardOwnNewCustomCommand(5, STREAMER_ID);

    expect(conn.execute.mock.calls[0]![0]).toContain('FOR UPDATE');
    expect(conn.execute.mock.calls[3]![0]).toContain('DELETE FROM custom_command');
    expect(conn.commit).toHaveBeenCalled();
  });

  it('leaves the command alone when a Mod adopted it in the meantime', async () => {
    const pool = makePool();
    const conn = pool._conn;
    for (const result of ownershipRows({ is_discord_enabled: 0, is_multi_twitch: 0 }, [OTHER_ID])) {
      conn.execute.mockResolvedValueOnce(result);
    }
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(discardOwnNewCustomCommand(5, STREAMER_ID)).rejects.toThrow('Command not self-manageable: 5');
    expect(conn.execute).toHaveBeenCalledTimes(2);
    expect(conn.rollback).toHaveBeenCalled();
  });
});

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

  it('still rejects with the original error when rollback itself fails', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])  // DELETE twitch_user_commands
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);  // DELETE custom_command — not found
    conn.rollback.mockRejectedValue(new Error('rollback failed'));
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
