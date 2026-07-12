import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));
vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));
vi.mock('./commandStringUtils', () => ({
  CommandConflictError: class CommandConflictError extends Error {
    commands: string[];
    constructor(cmds: string[]) {
      super(String(cmds));
      this.commands = cmds;
    }
  },
  normalizeCommandInputs: vi.fn((x: string | string[]) => (Array.isArray(x) ? x : [x]).map((s: string) => s.trim().toLowerCase()).filter(Boolean)),
  buildInClausePlaceholders: vi.fn((n: number) => Array(n).fill('?').join(',')),
}));

import { getPool } from './pool';
import { isDeadlockError, getCommandWriteLockName, acquireNamedLock, isAnyCommandTakenAcrossTables, runSerializedCommandWrite, MAX_DEADLOCK_RETRIES } from './commandLocks';
import { CommandConflictError } from './commandStringUtils';

describe('isDeadlockError', () => {
  it('returns true when code is ER_LOCK_DEADLOCK', () => {
    expect(isDeadlockError({ code: 'ER_LOCK_DEADLOCK' })).toBe(true);
  });

  it('returns true when errno is 1213', () => {
    expect(isDeadlockError({ errno: 1213 })).toBe(true);
  });

  it('returns true when both code and errno indicate a deadlock', () => {
    expect(isDeadlockError({ code: 'ER_LOCK_DEADLOCK', errno: 1213 })).toBe(true);
  });

  it('returns false for a different error code', () => {
    expect(isDeadlockError({ code: 'ER_OTHER' })).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isDeadlockError({})).toBe(false);
  });

  it('throws when passed null (cannot read properties of null)', () => {
    expect(() => isDeadlockError(null)).toThrow();
  });

  it('throws when passed undefined (cannot read properties of undefined)', () => {
    expect(() => isDeadlockError(undefined)).toThrow();
  });

  it('returns false for a plain string', () => {
    expect(isDeadlockError('ER_LOCK_DEADLOCK')).toBe(false);
  });
});

describe('getCommandWriteLockName', () => {
  it('returns a string that starts with bcuk_cmd_', () => {
    const lockName = getCommandWriteLockName('!test');
    expect(lockName.startsWith('bcuk_cmd_')).toBe(true);
  });

  it('is deterministic — same input always returns the same string', () => {
    const first = getCommandWriteLockName('!clap');
    const second = getCommandWriteLockName('!clap');
    expect(first).toBe(second);
  });

  it('total length is at most 64 characters (MySQL named lock limit)', () => {
    const lockName = getCommandWriteLockName('!some-very-long-command-trigger-string');
    expect(lockName.length).toBeLessThanOrEqual(64);
  });

  it('different commands produce different lock names', () => {
    const a = getCommandWriteLockName('!clap');
    const b = getCommandWriteLockName('!hug');
    expect(a).not.toBe(b);
  });

  it('the hash portion after bcuk_cmd_ is exactly 48 hex characters', () => {
    const lockName = getCommandWriteLockName('!test');
    const prefix = 'bcuk_cmd_';
    const hashPart = lockName.slice(prefix.length);
    expect(hashPart).toHaveLength(48);
    expect(hashPart).toMatch(/^[0-9a-f]{48}$/);
  });
});

// ─── acquireNamedLock ─────────────────────────────────────────────────────────

describe('acquireNamedLock', () => {
  function makeConn(lockStatus: unknown) {
    return { execute: vi.fn().mockResolvedValue([[{ lock_status: lockStatus }], []]) };
  }

  it('resolves without error when lock_status is the string "1"', async () => {
    await expect(acquireNamedLock(makeConn('1') as any, 'test_lock')).resolves.not.toThrow();
  });

  it('resolves without error when lock_status is the number 1', async () => {
    await expect(acquireNamedLock(makeConn(1) as any, 'test_lock')).resolves.not.toThrow();
  });

  it('throws a timeout error when lock_status is the string "0"', async () => {
    await expect(acquireNamedLock(makeConn('0') as any, 'test_lock')).rejects.toThrow('Timed out acquiring command write lock');
  });

  it('throws a timeout error when lock_status is the number 0', async () => {
    await expect(acquireNamedLock(makeConn(0) as any, 'test_lock')).rejects.toThrow('Timed out acquiring command write lock');
  });

  it('throws an internal error when lock_status is null', async () => {
    await expect(acquireNamedLock(makeConn(null) as any, 'test_lock')).rejects.toThrow('Internal error acquiring command write lock');
  });

  it('throws an unexpected-result error for an unrecognized lock_status value', async () => {
    await expect(acquireNamedLock(makeConn('unexpected') as any, 'test_lock')).rejects.toThrow('Unexpected result acquiring command write lock');
  });

  it('includes the lock name in the error message', async () => {
    const error = await acquireNamedLock(makeConn('0') as any, 'bcuk_cmd_abc123').catch((e) => e);
    expect(error.message).toContain('bcuk_cmd_abc123');
  });

  it('calls GET_LOCK with the lock name and timeout', async () => {
    const conn = makeConn('1');
    await acquireNamedLock(conn as any, 'my_lock');
    const [sql, params] = conn.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('GET_LOCK');
    expect(params[0]).toBe('my_lock');
  });
});

// ─── isAnyCommandTakenAcrossTables ────────────────────────────────────────────

describe('isAnyCommandTakenAcrossTables', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false immediately for an empty array without querying', async () => {
    const pool = { execute: vi.fn() };
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await isAnyCommandTakenAcrossTables([]);
    expect(result).toBe(false);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('returns false when both tables return no rows', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[]]  ) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await isAnyCommandTakenAcrossTables('!test');
    expect(result).toBe(false);
  });

  it('returns true when custom_command table returns a row', async () => {
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[{ '1': 1 }]])  // custom_command hit
        .mockResolvedValueOnce([[]]),             // counter miss
    };
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await isAnyCommandTakenAcrossTables('!test');
    expect(result).toBe(true);
  });

  it('returns true when only counter table returns a row', async () => {
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[]])               // custom_command miss
        .mockResolvedValueOnce([[{ '1': 1 }]]),   // counter hit
    };
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await isAnyCommandTakenAcrossTables('!test');
    expect(result).toBe(true);
  });

  it('skips custom_command table when includeCustomCommandTable is false', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[]]  ) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await isAnyCommandTakenAcrossTables('!test', undefined, pool as any, { includeCustomCommandTable: false, includeCounterTable: true });
    const sql: string = pool.execute.mock.calls[0][0];
    expect(sql).toContain('counter');
    expect(sql).not.toContain('custom_command');
  });

  it('skips counter table when includeCounterTable is false', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[]]  ) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await isAnyCommandTakenAcrossTables('!test', undefined, pool as any, { includeCustomCommandTable: true, includeCounterTable: false });
    expect(pool.execute).toHaveBeenCalledOnce();
    const sql: string = pool.execute.mock.calls[0][0];
    expect(sql).toContain('custom_command');
  });

  it('passes excludeCustomCommandId to custom_command query', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[]]  ) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await isAnyCommandTakenAcrossTables('!test', { excludeCustomCommandId: 7 }, pool as any);
    const customCmdCall = pool.execute.mock.calls.find((args) => (args[0] as string).includes('custom_command'));
    expect(customCmdCall).toBeDefined();
    expect(customCmdCall![1]).toContain(7);
  });
});

// ─── runSerializedCommandWrite ────────────────────────────────────────────────

// existsResults: array of row arrays returned for each SELECT 1 FROM check.
// Pass [[]] for "no conflict" (empty rows), [[{ '1': 1 }]] for "conflict".
function makeSerializedWriteConnection(existsResults: Array<unknown[]> = [[], []]) {
  let existsCallIndex = 0;
  const conn = {
    execute: vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT GET_LOCK')) return [[{ lock_status: '1' }], []];
      if (sql.startsWith('SELECT RELEASE_LOCK')) return [[], []];
      if (sql.startsWith('SELECT 1 FROM')) return [existsResults[existsCallIndex++] ?? [], []];
      return [[], []];
    }),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  return conn;
}

describe('runSerializedCommandWrite', () => {
  it('calls writeOperation once and commits when no conflict and no deadlock', async () => {
    const conn = makeSerializedWriteConnection();
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    const writeOp = vi.fn().mockResolvedValue('result');
    const result = await runSerializedCommandWrite('!test', undefined, writeOp);

    expect(writeOp).toHaveBeenCalledOnce();
    expect(conn.commit).toHaveBeenCalledOnce();
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
    expect(result).toBe('result');
  });

  it('throws CommandConflictError immediately (no retry) when command is taken', async () => {
    // First exists check returns a row (trigger taken); second check not reached
    const conn = makeSerializedWriteConnection([[{ '1': 1 }], []]);
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    const writeOp = vi.fn();
    await expect(runSerializedCommandWrite('!test', undefined, writeOp)).rejects.toBeInstanceOf(CommandConflictError);
    expect(writeOp).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalledOnce();
    expect(conn.release).toHaveBeenCalled();
  });

  it('retries on deadlock and succeeds on second attempt', async () => {
    const conn = makeSerializedWriteConnection();
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    const deadlockError = Object.assign(new Error('Deadlock'), { code: 'ER_LOCK_DEADLOCK' });
    const writeOp = vi.fn()
      .mockRejectedValueOnce(deadlockError)
      .mockResolvedValueOnce('ok');

    const result = await runSerializedCommandWrite('!test', undefined, writeOp);

    expect(writeOp).toHaveBeenCalledTimes(2);
    expect(conn.rollback).toHaveBeenCalledOnce();
    expect(conn.commit).toHaveBeenCalledOnce();
    expect(result).toBe('ok');
    expect(conn.release).toHaveBeenCalled();
  });

  it(`throws after ${MAX_DEADLOCK_RETRIES} consecutive deadlocks`, async () => {
    const conn = makeSerializedWriteConnection();
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    const deadlockError = Object.assign(new Error('Deadlock'), { code: 'ER_LOCK_DEADLOCK' });
    const writeOp = vi.fn().mockRejectedValue(deadlockError);

    await expect(runSerializedCommandWrite('!test', undefined, writeOp)).rejects.toThrow('Deadlock');
    expect(writeOp).toHaveBeenCalledTimes(MAX_DEADLOCK_RETRIES);
    expect(conn.rollback).toHaveBeenCalledTimes(MAX_DEADLOCK_RETRIES);
    expect(conn.release).toHaveBeenCalled();
  });

  it('re-throws non-deadlock errors immediately without retry', async () => {
    const conn = makeSerializedWriteConnection();
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    const dupError = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
    const writeOp = vi.fn().mockRejectedValue(dupError);

    await expect(runSerializedCommandWrite('!test', undefined, writeOp)).rejects.toThrow('Duplicate entry');
    expect(writeOp).toHaveBeenCalledOnce();
    expect(conn.release).toHaveBeenCalled();
  });

  it('releases connection even when acquireNamedLock throws', async () => {
    const conn = {
      execute: vi.fn().mockResolvedValue([[{ lock_status: '0' }]]),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    await expect(runSerializedCommandWrite('!test', undefined, vi.fn())).rejects.toThrow();
    expect(conn.release).toHaveBeenCalled();
  });
});
