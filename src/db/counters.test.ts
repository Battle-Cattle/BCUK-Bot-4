import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
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
  CommandConflictError: class CommandConflictError extends Error {
    constructor(cmds: string[]) { super(String(cmds)); }
  },
}));
vi.mock('./reservedCommands', () => ({
  assertNotReservedCommand: vi.fn(),
}));
vi.mock('./utils', () => ({
  fromBit: vi.fn((v: unknown) => (Buffer.isBuffer(v) ? v[0] === 1 : v == 1)),
}));
vi.mock('./counterCache', () => ({
  invalidateCounterLookupCache: vi.fn(),
}));

// Shared mock connection used by runSerializedCommandWrite
const mockConnection = {
  execute: vi.fn(),
  beginTransaction: vi.fn().mockResolvedValue(undefined),
  commit: vi.fn().mockResolvedValue(undefined),
  rollback: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
};

import { getPool } from './pool';
import {
  getAllCounters,
  addCounter,
  updateCounter,
  removeCounter,
  resetCounterCurrentValue,
  incrementCounter,
  archiveAndResetYearlyCounters,
  CounterNotFoundError,
} from './counters';
import { runSerializedCommandWrite } from './commandLocks';
import { assertNotReservedCommand } from './reservedCommands';
import { invalidateCounterLookupCache } from './counterCache';

function makePool(rows: unknown[] = [], meta: unknown = {}) {
  const conn = {
    execute: vi.fn(),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  return {
    execute: vi.fn().mockResolvedValue([[...rows], meta]),
    getConnection: vi.fn().mockResolvedValue(conn),
    _conn: conn,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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

  it('invalidates the counter cache after success', async () => {
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    mockConnection.execute.mockResolvedValue([{}, []]);
    await addCounter('!hits', '!checkhits', 'msg', 'inc', false);
    expect(invalidateCounterLookupCache).toHaveBeenCalled();
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

  it('invalidates the counter cache after success', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!old', check_command: '!oldcheck' }]) as any);
    mockConnection.execute.mockResolvedValue([{ affectedRows: 1 }, []]);
    await updateCounter({ id: 1, triggerCommand: '!new', checkCommand: '!check', message: 'm', incrementMessage: 'i', resetYearly: false });
    expect(invalidateCounterLookupCache).toHaveBeenCalled();
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

  it('invalidates cache after removal', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ trigger_command: '!hits', check_command: '!checkhits' }]) as any);
    mockConnection.execute.mockResolvedValue([{ affectedRows: 1 }, []]);
    await removeCounter(1);
    expect(invalidateCounterLookupCache).toHaveBeenCalled();
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

  it('invalidates cache on success', async () => {
    const pool = makePool();
    pool.execute.mockResolvedValue([[{ affectedRows: 1 }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await resetCounterCurrentValue(1);
    expect(invalidateCounterLookupCache).toHaveBeenCalled();
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
      .mockResolvedValueOnce([[{ current_value: 7 }], []]);    // SELECT: rows
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await incrementCounter(1);
    expect(result).toBe(7);
    expect(conn.commit).toHaveBeenCalled();
  });

  it('releases the connection even when it throws', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute.mockRejectedValue(new Error('DB error'));
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(incrementCounter(1)).rejects.toThrow('DB error');
    expect(conn.release).toHaveBeenCalled();
  });

  it('invalidates cache on success', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([[{ affectedRows: 1 }], []])
      .mockResolvedValueOnce([[{ current_value: 3 }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await incrementCounter(1);
    expect(invalidateCounterLookupCache).toHaveBeenCalled();
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

  it('invalidates cache after archiving', async () => {
    const pool = makePool();
    pool.execute.mockResolvedValue([{ affectedRows: 2 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await archiveAndResetYearlyCounters(2025);
    expect(invalidateCounterLookupCache).toHaveBeenCalled();
  });
});
