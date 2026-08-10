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
vi.mock('./commandLocks', () => ({
  runSerializedCommandWrite: vi.fn(async (_cmds: unknown, _opts: unknown, fn: (conn: unknown) => Promise<unknown>) => fn(mockConnection)),
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
  getCounterCount,
  getCounterHistory,
  addCounter,
  updateCounter,
  removeCounter,
  resetCounterCurrentValue,
  incrementCounter,
  archiveAndResetYearlyCounters,
  invalidateArchiveColumnsCache,
  CounterNotFoundError,
} from './counters';
import { runSerializedCommandWrite } from './commandLocks';
import { assertNotReservedCommand } from './reservedCommands';
import { getRowCount } from './utils';
import { makeMockPool } from '../test-utils/mockMysqlPool';

/** Builds a fake pool via the shared helper, matching this file's historical `(rows, meta)` call shape. */
function makePool(rows: unknown[] = [], meta: unknown = {}) {
  return makeMockPool({ rows, meta });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The archive-columns cache is a module-level singleton (5-minute TTL in
  // production) so it must be reset between tests, or a later test's
  // getCounterHistory call would silently reuse an earlier test's cached columns
  // instead of hitting its own `pool.query` mock.
  invalidateArchiveColumnsCache();
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
  it('delegates to getRowCount for the counter table', async () => {
    vi.mocked(getRowCount).mockResolvedValue(4);
    expect(await getCounterCount()).toBe(4);
    expect(getRowCount).toHaveBeenCalledWith('counter');
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
    expect(result[0].reset_yearly).toBe(true);
    expect(result[1].reset_yearly).toBe(false);
    expect(result[0].current_value).toBe(5);
  });
});

// ─── getCounterHistory ─────────────────────────────────────────────────────────

describe('getCounterHistory', () => {
  it('returns null when the counter does not exist', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getCounterHistory(99)).toBeNull();
  });

  it('returns the counter and archived years newest-first, filtering out nulls', async () => {
    const row = {
      id: 1,
      trigger_command: '!hits',
      check_command: '!checkhits',
      message: 'msg',
      increment_message: 'inc',
      reset_yearly: 1,
      current_value: 5,
      value2023: 10,
      value2024: 20,
      value2025: null,
    };
    const pool = makePool([row]);
    pool.query.mockResolvedValue([
      [{ COLUMN_NAME: 'value2023' }, { COLUMN_NAME: 'value2024' }, { COLUMN_NAME: 'value2025' }],
      {},
    ]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getCounterHistory(1);
    expect(result).not.toBeNull();
    expect(result!.counter.id).toBe(1);
    expect(result!.counter.reset_yearly).toBe(true);
    expect(result!.history).toEqual([
      { year: 2024, value: 20 },
      { year: 2023, value: 10 },
    ]);
  });

  it('returns an empty history array for a counter with no archived years', async () => {
    const row = {
      id: 2,
      trigger_command: '!deaths',
      check_command: '!checkdeaths',
      message: 'msg',
      increment_message: 'inc',
      reset_yearly: 0,
      current_value: 0,
    };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await getCounterHistory(2);
    expect(result).not.toBeNull();
    expect(result!.history).toEqual([]);
  });

  it('only selects value<year> columns that actually exist on the table, ignoring the rest of the allowlist', async () => {
    // Regression test: ARCHIVE_YEAR_COLUMNS spans 2020-2100 as an allowlist, but per
    // DATABASE-SCHEMA.md the physical columns are added one year at a time — the schema
    // may only have e.g. value2020..value2025. Querying the full allowlist blindly used
    // to throw "Unknown column 'value2026' in 'field list'" in production.
    const row = {
      id: 3,
      trigger_command: '!wins',
      check_command: '!checkwins',
      message: 'msg',
      increment_message: 'inc',
      reset_yearly: 1,
      current_value: 1,
      value2025: 7,
    };
    const pool = makePool([row]);
    pool.query.mockResolvedValue([[{ COLUMN_NAME: 'value2025' }], {}]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    const result = await getCounterHistory(3);

    expect(result!.history).toEqual([{ year: 2025, value: 7 }]);
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain('`value2025`');
    expect(sql).not.toContain('value2026');
    expect(sql).not.toContain('value2100');
  });

  it('queries information_schema scoped to the counter table for existing archive columns', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await getCounterHistory(1);

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('information_schema.COLUMNS');
    expect(sql).toContain("TABLE_NAME = 'counter'");
  });

  it('caches the existing-columns lookup so browsing multiple counters only queries information_schema once', async () => {
    const pool = makePool([{ id: 1 }]);
    pool.query.mockResolvedValue([[{ COLUMN_NAME: 'value2025' }], {}]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await getCounterHistory(1);
    await getCounterHistory(2);
    await getCounterHistory(3);

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('excludes the current year (and any future year) even if the column exists and holds a non-null value', async () => {
    // archiveAndResetYearlyCounters only ever writes into the *previous*
    // completed year's column, so the current/future year can never have valid
    // archived data — this must be excluded outright, not just via NULL-filtering.
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;
    const row: Record<string, unknown> = {
      id: 4,
      trigger_command: '!streak',
      check_command: '!checkstreak',
      message: 'msg',
      increment_message: 'inc',
      reset_yearly: 1,
      current_value: 3,
      [`value${lastYear}`]: 42,
      [`value${currentYear}`]: 99, // stray non-null value; must never surface as history
    };
    const pool = makePool([row]);
    pool.query.mockResolvedValue([
      [{ COLUMN_NAME: `value${lastYear}` }, { COLUMN_NAME: `value${currentYear}` }],
      {},
    ]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    const result = await getCounterHistory(4);

    expect(result!.history).toEqual([{ year: lastYear, value: 42 }]);
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain(`\`value${lastYear}\``);
    expect(sql).not.toContain(`value${currentYear}`);
  });
});

// ─── addCounter ──────────────────────────────────────────────────────────────

describe('addCounter', () => {
  it('throws when trigger and check command are the same', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(addCounter('!hits', '!hits', 'msg', 'inc', false)).rejects.toThrow('must be different');
  });

  it('calls assertNotReservedCommand for both commands', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    mockConnection.execute.mockResolvedValue([{}, []]);
    await addCounter('!hits', '!checkhits', 'msg', 'inc', false);
    expect(assertNotReservedCommand).toHaveBeenCalledWith('!hits');
    expect(assertNotReservedCommand).toHaveBeenCalledWith('!checkhits');
  });

  it('calls runSerializedCommandWrite with both commands', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    mockConnection.execute.mockResolvedValue([{}, []]);
    await addCounter('!hits', '!checkhits', 'msg', 'inc', true);
    expect(runSerializedCommandWrite).toHaveBeenCalledWith(
      ['!hits', '!checkhits'],
      undefined,
      expect.any(Function),
    );
  });

  it('throws when trigger and check differ only by case (normalized to same value)', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(addCounter('!HITS', '!hits', 'msg', 'inc', false)).rejects.toThrow('must be different');
  });
});

// ─── updateCounter ────────────────────────────────────────────────────────────

describe('updateCounter', () => {
  it('throws when trigger and check are the same', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!old', check_command: '!oldcheck' }]) as any);
    await expect(updateCounter({ id: 1, triggerCommand: '!hits', checkCommand: '!hits', message: 'm', incrementMessage: 'i', resetYearly: false }))
      .rejects.toThrow('must be different');
  });

  it('throws CounterNotFoundError when getCounterCommandsById returns null', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    await expect(updateCounter({ id: 99, triggerCommand: '!hits', checkCommand: '!check', message: 'm', incrementMessage: 'i', resetYearly: false }))
      .rejects.toBeInstanceOf(CounterNotFoundError);
  });

  it('calls assertNotReservedCommand for both commands', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!old', check_command: '!oldcheck' }]) as any);
    mockConnection.execute.mockResolvedValue([{ affectedRows: 1 }, []]);
    await updateCounter({ id: 1, triggerCommand: '!new', checkCommand: '!newcheck', message: 'm', incrementMessage: 'i', resetYearly: false });
    expect(assertNotReservedCommand).toHaveBeenCalledWith('!new');
    expect(assertNotReservedCommand).toHaveBeenCalledWith('!newcheck');
  });

});

// ─── removeCounter ────────────────────────────────────────────────────────────

describe('removeCounter', () => {
  it('throws CounterNotFoundError when counter does not exist', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    await expect(removeCounter(99)).rejects.toBeInstanceOf(CounterNotFoundError);
  });

  it('calls runSerializedCommandWrite with existing commands', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!hits', check_command: '!checkhits' }]) as any);
    mockConnection.execute.mockResolvedValue([{ affectedRows: 1 }, []]);
    await removeCounter(1);
    expect(runSerializedCommandWrite).toHaveBeenCalledWith(
      ['!hits', '!checkhits'],
      { excludeCounterId: 1 },
      expect.any(Function),
    );
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
    await expect(resetCounterCurrentValue(99)).rejects.toBeInstanceOf(CounterNotFoundError);
  });

  it('does not throw when affectedRows > 0', async () => {
    const pool = makePool();
    pool.execute.mockResolvedValue([{ affectedRows: 1 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(resetCounterCurrentValue(1)).resolves.not.toThrow();
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
    const [updateSql] = conn.execute.mock.calls[0];
    const [selectSql, selectParams] = conn.execute.mock.calls[1];
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

// ─── archiveAndResetYearlyCounters ────────────────────────────────────────────

describe('archiveAndResetYearlyCounters', () => {
  it('throws for a year before 2020', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(archiveAndResetYearlyCounters(2019)).rejects.toThrow('Invalid archive year: 2019');
  });

  it('throws for a year after 2100', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(archiveAndResetYearlyCounters(2101)).rejects.toThrow('Invalid archive year: 2101');
  });

  it('accepts year 2020 (lower boundary)', async () => {
    const pool = makePool();
    pool.execute.mockResolvedValue([{ affectedRows: 3 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(archiveAndResetYearlyCounters(2020)).resolves.toBe(3);
  });

  it('accepts year 2100 (upper boundary)', async () => {
    const pool = makePool();
    pool.execute.mockResolvedValue([{ affectedRows: 0 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(archiveAndResetYearlyCounters(2100)).resolves.toBe(0);
  });

  it('returns the number of affected rows', async () => {
    const pool = makePool();
    pool.execute.mockResolvedValue([{ affectedRows: 5 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await archiveAndResetYearlyCounters(2024)).toBe(5);
  });

  it('includes the column name for the given year in the SQL', async () => {
    const pool = makePool();
    pool.execute.mockResolvedValue([{ affectedRows: 1 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await archiveAndResetYearlyCounters(2024);
    const [sql] = pool.execute.mock.calls[0] as [string];
    expect(sql).toContain('value2024');
  });
});
