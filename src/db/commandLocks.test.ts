import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));
vi.mock('../shared/logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));
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
import { isDeadlockError, getCommandWriteLockName, acquireNamedLock, isAnyCommandTakenAcrossTables } from './commandLocks';
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
