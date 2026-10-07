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

import { getPool } from './pool';
import { getCounterHistory, archiveAndResetYearlyCounters, invalidateArchiveColumnsCache } from './counterArchive';
import { makeMockPool, makeMockConnection } from '../test-utils/mockMysqlPool';

// Shared mock connection used by the mocked runSerializedCommandWrite (counters.ts is imported for mapCounter).
const mockConnection = makeMockConnection();

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

// ─── getCounterHistory ─────────────────────────────────────────────────────────

describe('getCounterHistory', () => {
  it('returns null when the counter does not exist', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getCounterHistory('guild-1', 99)).toBeNull();
  });

  it('still returns the counter, with no history, when the archive-column lookup fails', async () => {
    const row = { id: 1, trigger_command: '!hits', check_command: '!checkhits', message: 'm', increment_message: 'i', reset_yearly: 1, current_value: 5 };
    const pool = makePool([row]);
    pool.query.mockRejectedValueOnce(new Error('information_schema unavailable'));
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getCounterHistory('guild-1', 1);
    expect(result?.history).toEqual([]);
    expect(result?.counter.id).toBe(1);
    const [sql] = pool.execute.mock.calls[0]!;
    expect(sql).not.toContain('value20');
  });

  it('scopes the lookup to the given guild id', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getCounterHistory('guild-1', 1);
    const [sql, params] = pool.execute.mock.calls[0]!;
    expect(sql).toContain('WHERE id = ? AND guild_id = ?');
    expect(params).toEqual([1, 'guild-1']);
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
    const result = await getCounterHistory('guild-1', 1);
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
    const result = await getCounterHistory('guild-1', 2);
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

    const result = await getCounterHistory('guild-1', 3);

    expect(result!.history).toEqual([{ year: 2025, value: 7 }]);
    const [sql] = pool.execute.mock.calls[0]!;
    expect(sql).toContain('`value2025`');
    expect(sql).not.toContain('value2026');
    expect(sql).not.toContain('value2100');
  });

  it('queries information_schema scoped to the counter table for existing archive columns', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await getCounterHistory('guild-1', 1);

    const [sql] = pool.query.mock.calls[0]!;
    expect(sql).toContain('information_schema.COLUMNS');
    expect(sql).toContain("TABLE_NAME = 'counter'");
  });

  it('caches the existing-columns lookup so browsing multiple counters only queries information_schema once', async () => {
    const pool = makePool([{ id: 1 }]);
    pool.query.mockResolvedValue([[{ COLUMN_NAME: 'value2025' }], {}]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await getCounterHistory('guild-1', 1);
    await getCounterHistory('guild-1', 2);
    await getCounterHistory('guild-1', 3);

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

    const result = await getCounterHistory('guild-1', 4);

    expect(result!.history).toEqual([{ year: lastYear, value: 42 }]);
    const [sql] = pool.execute.mock.calls[0]!;
    expect(sql).toContain(`\`value${lastYear}\``);
    expect(sql).not.toContain(`value${currentYear}`);
  });
});

// ─── archiveAndResetYearlyCounters ────────────────────────────────────────────

describe('archiveAndResetYearlyCounters', () => {
  /** Pool whose transaction connection claims the marker (affectedRows 1), then runs the UPDATE. */
  function archivePool(updateAffected: number, claimAffected = 1) {
    const pool = makePool();
    pool._conn.execute
      .mockResolvedValueOnce([{ affectedRows: claimAffected }, []])
      .mockResolvedValueOnce([{ affectedRows: updateAffected }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    return pool;
  }

  it('throws for a year before 2020', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(archiveAndResetYearlyCounters(2019)).rejects.toThrow('Invalid archive year: 2019');
  });

  it('throws for a year after 2100', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(archiveAndResetYearlyCounters(2101)).rejects.toThrow('Invalid archive year: 2101');
  });

  it('accepts year 2020 (lower boundary)', async () => {
    archivePool(3);
    await expect(archiveAndResetYearlyCounters(2020)).resolves.toBe(3);
  });

  it('accepts year 2100 (upper boundary)', async () => {
    archivePool(0);
    await expect(archiveAndResetYearlyCounters(2100)).resolves.toBe(0);
  });

  it('claims the year marker, then archives, in one committed transaction', async () => {
    const pool = archivePool(5);
    expect(await archiveAndResetYearlyCounters(2024)).toBe(5);
    const conn = pool._conn;
    expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
    const [claimSql, claimParams] = conn.execute.mock.calls[0]!;
    expect(claimSql).toContain('INSERT IGNORE INTO counter_archive_run');
    expect(claimParams).toEqual([2024]);
    const [updateSql] = conn.execute.mock.calls[1] as [string];
    expect(updateSql).toContain('value2024');
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
  });

  it('is a no-op returning 0 when the year marker already exists', async () => {
    const pool = archivePool(9, 0);
    expect(await archiveAndResetYearlyCounters(2024)).toBe(0);
    expect(pool._conn.execute).toHaveBeenCalledTimes(1); // no UPDATE
    expect(pool._conn.commit).toHaveBeenCalledTimes(1);
  });

  it('rolls back the marker claim when the UPDATE fails, so a later tick retries', async () => {
    const pool = makePool();
    pool._conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockRejectedValueOnce(new Error("Unknown column 'value2024'"));
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(archiveAndResetYearlyCounters(2024)).rejects.toThrow("Unknown column 'value2024'");
    expect(pool._conn.rollback).toHaveBeenCalledTimes(1);
    expect(pool._conn.commit).not.toHaveBeenCalled();
    expect(pool._conn.release).toHaveBeenCalled();
  });

  it('propagates (after rollback) when the counter_archive_run table is missing', async () => {
    const pool = makePool();
    pool._conn.execute.mockRejectedValueOnce(new Error("Table 'counter_archive_run' doesn't exist"));
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(archiveAndResetYearlyCounters(2024)).rejects.toThrow("doesn't exist");
    expect(pool._conn.rollback).toHaveBeenCalledTimes(1);
  });

  describe('archive column', () => {
    it('adds the missing value<year> column before the transaction', async () => {
      const pool = archivePool(2);
      pool.query.mockResolvedValueOnce([[], []]); // column lookup: not found
      expect(await archiveAndResetYearlyCounters(2026)).toBe(2);
      const [lookupSql, lookupParams] = pool.query.mock.calls[0]!;
      expect(lookupSql).toContain('information_schema.COLUMNS');
      expect(lookupParams).toEqual(['value2026']);
      expect(pool.query.mock.calls[1]![0]).toBe('ALTER TABLE counter ADD COLUMN `value2026` INT NULL');
      expect(pool.query.mock.invocationCallOrder[1]!).toBeLessThan(pool._conn.beginTransaction.mock.invocationCallOrder[0]!);
    });

    it('skips the ALTER when the column already exists', async () => {
      const pool = archivePool(2);
      pool.query.mockResolvedValueOnce([[{ 1: 1 }], []]);
      expect(await archiveAndResetYearlyCounters(2026)).toBe(2);
      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it('treats a concurrent add (ER_DUP_FIELDNAME) as success', async () => {
      const pool = archivePool(1);
      pool.query
        .mockResolvedValueOnce([[], []])
        .mockRejectedValueOnce(Object.assign(new Error("Duplicate column name 'value2026'"), { code: 'ER_DUP_FIELDNAME', errno: 1060 }));
      expect(await archiveAndResetYearlyCounters(2026)).toBe(1);
    });

    it('propagates other ALTER failures without starting the transaction', async () => {
      const pool = archivePool(1);
      pool.query
        .mockResolvedValueOnce([[], []])
        .mockRejectedValueOnce(Object.assign(new Error('ALTER command denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 }));
      await expect(archiveAndResetYearlyCounters(2026)).rejects.toThrow('ALTER command denied');
      expect(pool._conn.beginTransaction).not.toHaveBeenCalled();
    });

    it('invalidates the archive-columns cache after adding the column', async () => {
      const pool = archivePool(0);
      const isColumnListQuery = (sql: unknown) => String(sql).includes("LIKE 'value2%'");
      await getCounterHistory('guild-1', 1); // loads and caches the (empty) column list
      await getCounterHistory('guild-1', 1); // served from cache
      expect(pool.query.mock.calls.filter(([sql]) => isColumnListQuery(sql))).toHaveLength(1);

      pool.query.mockResolvedValueOnce([[], []]); // column lookup: not found → ALTER
      await archiveAndResetYearlyCounters(2024);
      await getCounterHistory('guild-1', 1);
      expect(pool.query.mock.calls.filter(([sql]) => isColumnListQuery(sql))).toHaveLength(2);
    });
  });
});
