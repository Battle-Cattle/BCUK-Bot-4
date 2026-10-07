import { describe, it, expect, vi, beforeEach } from 'vitest';

// `withTransaction` is reimplemented here (rather than via `importOriginal`) so this
// test doesn't pull in pool.ts's real `../shared/config` import chain, which throws
// in a test environment with no DISCORD_TOKEN etc. set. The logic mirrors pool.ts's
// real implementation exactly, driven by the same mocked `getPool()`.
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
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
  };
});
vi.mock('mysql2/promise', () => ({ default: {} }));
vi.mock('./commandWriteGuard', () => ({
  runSerializedCommandWrite: vi.fn(async (_cmds: unknown, _opts: unknown, fn: (conn: unknown) => Promise<unknown>) => fn(mockConnection)),
  isAnyCommandTakenAcrossTables: vi.fn(async () => false),
}));
vi.mock('./commandStringUtils', () => ({
  requireTrimmedString: vi.fn((v: string, _name: string, _max?: number) => {
    const t = v.trim();
    if (!t) throw new Error(`${_name} is required`);
    return t;
  }),
  normalizeCommand: vi.fn((command: string) => {
    const normalized = command.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }),
  normalizeCommandList: vi.fn((arr: string[]) => arr.map((s: string) => s.trim().toLowerCase())),
}));
vi.mock('./commandErrors', () => ({
  CommandConflictError: class CommandConflictError extends Error {
    constructor(cmds: string[]) { super(String(cmds)); }
  },
}));
vi.mock('./reservedCommands', () => ({
  assertNotReservedCommand: vi.fn(),
}));
vi.mock('./utils', () => ({
  fromBit: vi.fn((v: unknown) => (Buffer.isBuffer(v) ? v[0] === 1 : v == 1)),
  rowExists: vi.fn(async (executor: any, table: string, column: string, value: unknown) => {
    const [rows] = await executor.execute(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`, [value]);
    return rows.length > 0;
  }),
  affectedOrExists: vi.fn(async (affectedRows: number, existsCheck: () => Promise<boolean>) => {
    if (affectedRows > 0) return true;
    return existsCheck();
  }),
  getRowCount: vi.fn(),
}));

import { makeMockConnection } from '../test-utils/mockMysqlPool';

// Shared mock connection used by runSerializedCommandWrite
const mockConnection = makeMockConnection();

import { getPool } from './pool';
import {
  getAllCounters,
  getCountersForGuild,
  getCounterCount,
  addCounter,
  updateCounter,
  removeCounter,
  resetCounterCurrentValue,
  incrementCounter,
  isCounterCommandTaken,
  CounterNotFoundError,
} from './counters';
import { runSerializedCommandWrite, isAnyCommandTakenAcrossTables } from './commandWriteGuard';
import { assertNotReservedCommand } from './reservedCommands';
import { makeMockPool } from '../test-utils/mockMysqlPool';

/** Builds a fake pool via the shared helper, matching this file's historical `(rows, meta)` call shape. */
function makePool(rows: unknown[] = [], meta: unknown = {}) {
  return makeMockPool({ rows, meta });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAnyCommandTakenAcrossTables).mockResolvedValue(false);
});

// ─── CounterNotFoundError ────────────────────────────────────────────────────

describe('CounterNotFoundError', () => {
  it('has name CounterNotFoundError', () => {
    const err = new CounterNotFoundError(42);
    expect(err.name).toBe('CounterNotFoundError');
  });

  it('includes the id in the message', () => {
    expect(new CounterNotFoundError(7).message).toContain('7');
  });

  it('is an instance of Error', () => {
    expect(new CounterNotFoundError(1)).toBeInstanceOf(Error);
  });
});

// ─── getCounterCount ────────────────────────────────────────────────────────

describe('getCounterCount', () => {
  it('returns the counter row count scoped to the given guild', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ count: '4' }]) as any);
    expect(await getCounterCount('guild-1')).toBe(4);
  });

  it('scopes the query to the given guild id', async () => {
    const pool = makePool([{ count: '0' }]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getCounterCount('guild-1');
    const [sql, params] = pool.execute.mock.calls[0]!;
    expect(sql).toContain('WHERE guild_id = ?');
    expect(params).toEqual(['guild-1']);
  });
});

// ─── getAllCounters ───────────────────────────────────────────────────────────

describe('getAllCounters', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getAllCounters()).toEqual([]);
  });

  it('maps rows via fromBit for reset_yearly', async () => {
    const rows = [
      { id: 1, trigger_command: '!hits', check_command: '!checkhits', message: 'msg', increment_message: 'inc', reset_yearly: 1, current_value: 5 },
      { id: 2, trigger_command: '!deaths', check_command: '!checkdeaths', message: 'm2', increment_message: 'i2', reset_yearly: 0, current_value: 0 },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getAllCounters();
    expect(result).toHaveLength(2);
    expect(result[0]!.reset_yearly).toBe(true);
    expect(result[1]!.reset_yearly).toBe(false);
    expect(result[0]!.current_value).toBe(5);
  });
});

// ─── getCountersForGuild ────────────────────────────────────────────────────

describe('getCountersForGuild', () => {
  it('scopes the query to the given guild id', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getCountersForGuild('guild-1');
    const [sql, params] = pool.execute.mock.calls[0]!;
    expect(sql).toContain('WHERE guild_id = ?');
    expect(params).toEqual(['guild-1']);
  });

  it('maps guild_id onto each returned counter', async () => {
    const rows = [
      { id: 1, guild_id: '900000000000000001', trigger_command: '!hits', check_command: '!checkhits', message: 'msg', increment_message: 'inc', reset_yearly: 1, current_value: 5 },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getCountersForGuild('900000000000000001');
    expect(result[0]!.guild_id).toBe('900000000000000001');
  });
});

// ─── addCounter ──────────────────────────────────────────────────────────────

describe('addCounter', () => {
  function newCounter(overrides: Partial<{ triggerCommand: string; checkCommand: string; message: string; incrementMessage: string; resetYearly: boolean }> = {}) {
    return { triggerCommand: '!hits', checkCommand: '!checkhits', message: 'msg', incrementMessage: 'inc', resetYearly: false, ...overrides };
  }

  it('throws when trigger and check command are the same', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(addCounter('guild-1', newCounter({ checkCommand: '!hits' }))).rejects.toThrow('must be different');
  });

  it('calls assertNotReservedCommand for both commands', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    mockConnection.execute.mockResolvedValue([{}, []]);
    await addCounter('guild-1', newCounter());
    expect(assertNotReservedCommand).toHaveBeenCalledWith('!hits');
    expect(assertNotReservedCommand).toHaveBeenCalledWith('!checkhits');
  });

  it('calls runSerializedCommandWrite with both commands, scoped to the given guild', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    mockConnection.execute.mockResolvedValue([{}, []]);
    await addCounter('guild-1', newCounter({ resetYearly: true }));
    expect(runSerializedCommandWrite).toHaveBeenCalledWith(
      ['!hits', '!checkhits'],
      { guildId: 'guild-1' },
      expect.any(Function),
    );
  });

  it('inserts the counter with the given guild id', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    mockConnection.execute.mockResolvedValue([{}, []]);
    await addCounter('guild-1', newCounter({ resetYearly: true }));
    const [sql, params] = mockConnection.execute.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO counter (guild_id,');
    expect(params).toEqual(['guild-1', '!hits', '!checkhits', 'msg', 'inc', 1]);
  });

  it('throws when trigger and check differ only by case (normalized to same value)', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(addCounter('guild-1', newCounter({ triggerCommand: '!HITS', checkCommand: '!hits' }))).rejects.toThrow('must be different');
  });
});

// ─── updateCounter ────────────────────────────────────────────────────────────

/** Queues the under-lock re-read of the counter's current commands, then a successful UPDATE. */
function mockLockedCounterRow(trigger: string, check: string) {
  mockConnection.execute
    .mockResolvedValueOnce([[{ trigger_command: trigger, check_command: check }], []])
    .mockResolvedValue([{ affectedRows: 1 }, []]);
}

describe('updateCounter', () => {
  it('throws when trigger and check are the same', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!old', check_command: '!oldcheck' }]) as any);
    await expect(updateCounter('guild-1', { id: 1, triggerCommand: '!hits', checkCommand: '!hits', message: 'm', incrementMessage: 'i', resetYearly: false }))
      .rejects.toThrow('must be different');
  });

  it('throws CounterNotFoundError when getCounterCommandsById returns null', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    await expect(updateCounter('guild-1', { id: 99, triggerCommand: '!hits', checkCommand: '!check', message: 'm', incrementMessage: 'i', resetYearly: false }))
      .rejects.toBeInstanceOf(CounterNotFoundError);
  });

  it('calls assertNotReservedCommand for both commands', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!old', check_command: '!oldcheck' }]) as any);
    mockLockedCounterRow('!old', '!oldcheck');
    await updateCounter('guild-1', { id: 1, triggerCommand: '!new', checkCommand: '!newcheck', message: 'm', incrementMessage: 'i', resetYearly: false });
    expect(assertNotReservedCommand).toHaveBeenCalledWith('!new');
    expect(assertNotReservedCommand).toHaveBeenCalledWith('!newcheck');
  });

  it('treats a counter id belonging to a different guild as not found (never reads its commands)', async () => {
    // The lookup query itself is scoped by guild_id, so a counter belonging to another guild
    // returns no rows here — the same as a genuinely nonexistent id — rather than leaking its
    // current trigger/check commands to a caller in the wrong guild.
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(updateCounter('guild-1', { id: 1, triggerCommand: '!new', checkCommand: '!newcheck', message: 'm', incrementMessage: 'i', resetYearly: false }))
      .rejects.toBeInstanceOf(CounterNotFoundError);
    const [sql, params] = pool.execute.mock.calls[0]!;
    expect(sql).toContain('AND guild_id = ?');
    expect(params).toEqual([1, 'guild-1']);
  });

  it('scopes the UPDATE statement to the given guild id', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!old', check_command: '!oldcheck' }]) as any);
    mockLockedCounterRow('!old', '!oldcheck');
    await updateCounter('guild-1', { id: 1, triggerCommand: '!new', checkCommand: '!newcheck', message: 'm', incrementMessage: 'i', resetYearly: false });
    const [sql, params] = mockConnection.execute.mock.calls[1]!; // [0] is the under-lock re-read
    expect(sql).toContain('WHERE id = ? AND guild_id = ?');
    expect(params).toEqual(['!new', '!newcheck', 'm', 'i', 0, 1, 'guild-1']);
  });

  it('locks old and new commands but disables the built-in collision check', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!old', check_command: '!oldcheck' }]) as any);
    mockLockedCounterRow('!old', '!oldcheck');
    await updateCounter('guild-1', { id: 1, triggerCommand: '!new', checkCommand: '!newcheck', message: 'm', incrementMessage: 'i', resetYearly: false });
    expect(runSerializedCommandWrite).toHaveBeenCalledWith(
      ['!old', '!oldcheck', '!new', '!newcheck'],
      { guildId: 'guild-1' },
      expect.any(Function),
      { includeCustomCommandTable: false, includeCounterTable: false },
    );
  });

  it('collision-checks only the commands the counter is gaining', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!old', check_command: '!oldcheck' }]) as any);
    mockLockedCounterRow('!old', '!oldcheck');
    await updateCounter('guild-1', { id: 1, triggerCommand: '!old', checkCommand: '!newcheck', message: 'm', incrementMessage: 'i', resetYearly: false });
    expect(isAnyCommandTakenAcrossTables).toHaveBeenCalledWith(['!newcheck'], { excludeCounterId: 1, guildId: 'guild-1' }, mockConnection);
  });

  it('still allows editing a counter whose unchanged commands already collide (no collision check at all)', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!clash', check_command: '!check' }]) as any);
    mockLockedCounterRow('!clash', '!check');
    vi.mocked(isAnyCommandTakenAcrossTables).mockResolvedValue(true); // would collide if checked
    await updateCounter('guild-1', { id: 1, triggerCommand: '!clash', checkCommand: '!check', message: 'new msg', incrementMessage: 'i', resetYearly: true });
    expect(isAnyCommandTakenAcrossTables).not.toHaveBeenCalled();
    expect(mockConnection.execute).toHaveBeenCalledTimes(2);
  });

  it('allows renaming a colliding command away from the collision', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!clash', check_command: '!check' }]) as any);
    mockLockedCounterRow('!clash', '!check');
    await updateCounter('guild-1', { id: 1, triggerCommand: '!fresh', checkCommand: '!check', message: 'm', incrementMessage: 'i', resetYearly: false });
    expect(isAnyCommandTakenAcrossTables).toHaveBeenCalledWith(['!fresh'], { excludeCounterId: 1, guildId: 'guild-1' }, mockConnection);
    expect(mockConnection.execute.mock.calls[1]![1]).toEqual(['!fresh', '!check', 'm', 'i', 0, 1, 'guild-1']);
  });

  it('throws CommandConflictError (without updating) when a newly gained command is taken', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!old', check_command: '!oldcheck' }]) as any);
    mockLockedCounterRow('!old', '!oldcheck');
    vi.mocked(isAnyCommandTakenAcrossTables).mockResolvedValueOnce(true);
    await expect(updateCounter('guild-1', { id: 1, triggerCommand: '!taken', checkCommand: '!oldcheck', message: 'm', incrementMessage: 'i', resetYearly: false }))
      .rejects.toThrow('!taken');
    expect(mockConnection.execute).toHaveBeenCalledTimes(1); // only the re-read
  });

  it('throws CounterNotFoundError when the counter vanished before the locks were taken', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!old', check_command: '!oldcheck' }]) as any);
    mockConnection.execute.mockResolvedValueOnce([[], []]);
    await expect(updateCounter('guild-1', { id: 1, triggerCommand: '!new', checkCommand: '!newcheck', message: 'm', incrementMessage: 'i', resetYearly: false }))
      .rejects.toBeInstanceOf(CounterNotFoundError);
  });
});

// ─── removeCounter ────────────────────────────────────────────────────────────

describe('removeCounter', () => {
  it('throws CounterNotFoundError when counter does not exist', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    await expect(removeCounter('guild-1', 99)).rejects.toBeInstanceOf(CounterNotFoundError);
  });

  it('calls runSerializedCommandWrite with existing commands', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!hits', check_command: '!checkhits' }]) as any);
    mockConnection.execute.mockResolvedValue([{ affectedRows: 1 }, []]);
    await removeCounter('guild-1', 1);
    expect(runSerializedCommandWrite).toHaveBeenCalledWith(
      ['!hits', '!checkhits'],
      { guildId: 'guild-1' },
      expect.any(Function),
      // Lock only: a counter that already collides must still be deletable.
      { includeCustomCommandTable: false, includeCounterTable: false },
    );
  });

  it('treats a counter id belonging to a different guild as not found', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(removeCounter('guild-1', 1)).rejects.toBeInstanceOf(CounterNotFoundError);
    const [, params] = pool.execute.mock.calls[0]!;
    expect(params).toEqual([1, 'guild-1']);
  });

  it('scopes the DELETE statement to the given guild id', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!hits', check_command: '!checkhits' }]) as any);
    mockConnection.execute.mockResolvedValue([{ affectedRows: 1 }, []]);
    await removeCounter('guild-1', 1);
    const [sql, params] = mockConnection.execute.mock.calls[0]!;
    expect(sql).toContain('WHERE id = ? AND guild_id = ?');
    expect(params).toEqual([1, 'guild-1']);
  });
});

// ─── resetCounterCurrentValue ─────────────────────────────────────────────────

describe('resetCounterCurrentValue', () => {
  it('throws CounterNotFoundError when no rows affected and counter not found', async () => {
    const pool = makePool();
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])  // UPDATE: ResultSetHeader (affectedRows=0)
      .mockResolvedValueOnce([[], []]);                    // EXISTS check: no rows
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(resetCounterCurrentValue('guild-1', 99)).rejects.toBeInstanceOf(CounterNotFoundError);
  });

  it('does not throw when affectedRows > 0', async () => {
    const pool = makePool();
    pool.execute.mockResolvedValue([{ affectedRows: 1 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(resetCounterCurrentValue('guild-1', 1)).resolves.not.toThrow();
  });

  it('scopes the UPDATE statement to the given guild id', async () => {
    const pool = makePool();
    pool.execute.mockResolvedValue([{ affectedRows: 1 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await resetCounterCurrentValue('guild-1', 1);
    const [sql, params] = pool.execute.mock.calls[0]!;
    expect(sql).toContain('WHERE id = ? AND guild_id = ?');
    expect(params).toEqual([1, 'guild-1']);
  });
});

// ─── incrementCounter ─────────────────────────────────────────────────────────

describe('incrementCounter', () => {
  it('throws CounterNotFoundError when UPDATE affects 0 rows', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);  // UPDATE: ResultSetHeader
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(incrementCounter(99)).rejects.toBeInstanceOf(CounterNotFoundError);
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('returns the new current_value on success', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])       // UPDATE: ResultSetHeader
      .mockResolvedValueOnce([[{ current_value: 7 }], []]);    // SELECT LAST_INSERT_ID(): rows
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await incrementCounter(1);
    expect(result).toBe(7);
    expect(conn.commit).toHaveBeenCalled();
  });

  it('parses a string current_value into a number (LAST_INSERT_ID() is a BIGINT expression, so the pool\'s bigNumberStrings setting can return it as a string)', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([[{ current_value: '7' }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await incrementCounter(1);
    expect(result).toBe(7);
    expect(typeof result).toBe('number');
  });

  it('reads the new value via LAST_INSERT_ID() instead of re-querying the counter table', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([[{ current_value: 3 }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await incrementCounter(1);
    const [updateSql] = conn.execute.mock.calls[0]!;
    const [selectSql, selectParams] = conn.execute.mock.calls[1]!;
    expect(updateSql).toContain('LAST_INSERT_ID(current_value + 1)');
    expect(selectSql).toBe('SELECT LAST_INSERT_ID() AS current_value');
    expect(selectParams).toBeUndefined();
  });

  it('releases the connection even when it throws', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute.mockRejectedValue(new Error('DB error'));
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(incrementCounter(1)).rejects.toThrow('DB error');
    expect(conn.release).toHaveBeenCalled();
  });
});

// ─── isCounterCommandTaken ───────────────────────────────────────────────────

describe('isCounterCommandTaken', () => {
  it('returns true immediately for an array containing duplicates without delegating to isAnyCommandTakenAcrossTables', async () => {
    const result = await isCounterCommandTaken('guild-1', ['!hits', '!hits']);

    expect(result).toBe(true);
    expect(isAnyCommandTakenAcrossTables).not.toHaveBeenCalled();
  });

  it('delegates to isAnyCommandTakenAcrossTables for a single string input, scoped to the given guild', async () => {
    vi.mocked(isAnyCommandTakenAcrossTables).mockResolvedValue(false);

    await isCounterCommandTaken('guild-1', '!hits', 42);

    expect(isAnyCommandTakenAcrossTables).toHaveBeenCalledWith('!hits', { excludeCounterId: 42, guildId: 'guild-1' });
  });

  it('delegates to isAnyCommandTakenAcrossTables for an array with no duplicates, scoped to the given guild', async () => {
    vi.mocked(isAnyCommandTakenAcrossTables).mockResolvedValue(false);

    await isCounterCommandTaken('guild-1', ['!hits', '!checkhits']);

    expect(isAnyCommandTakenAcrossTables).toHaveBeenCalledWith(['!hits', '!checkhits'], { excludeCounterId: undefined, guildId: 'guild-1' });
  });
});
