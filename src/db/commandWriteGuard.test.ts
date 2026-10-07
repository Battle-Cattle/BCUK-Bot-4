import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import { isAnyCommandTakenAcrossTables, runSerializedCommandWrite } from './commandWriteGuard';
import { MAX_DEADLOCK_RETRIES } from './commandLocks';
import { CommandConflictError } from './commandErrors';

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
    const sql: string = pool.execute.mock.calls[0]![0];
    expect(sql).toContain('counter');
    expect(sql).not.toContain('custom_command');
  });

  it('skips counter table when includeCounterTable is false', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[]]  ) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await isAnyCommandTakenAcrossTables('!test', undefined, pool as any, { includeCustomCommandTable: true, includeCounterTable: false });
    expect(pool.execute).toHaveBeenCalledOnce();
    const sql: string = pool.execute.mock.calls[0]![0];
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

  it('scopes the counter query to guildId when given, without affecting the custom_command query', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[]]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await isAnyCommandTakenAcrossTables('!test', { guildId: 'guild-1' }, pool as any);
    const counterCall = pool.execute.mock.calls.find((args) => (args[0] as string).includes('counter'));
    const customCmdCall = pool.execute.mock.calls.find((args) => (args[0] as string).includes('custom_command'));
    expect(counterCall![0]).toContain('AND guild_id = ?');
    expect(counterCall![1]).toContain('guild-1');
    expect(customCmdCall![0]).not.toContain('guild_id');
  });

  it('checks the counter table across every guild when guildId is omitted', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[]]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await isAnyCommandTakenAcrossTables('!test', undefined, pool as any);
    const counterCall = pool.execute.mock.calls.find((args) => (args[0] as string).includes('counter'));
    expect(counterCall![0]).not.toContain('guild_id');
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

  it("runs on the caller's connection without taking one from the pool, and leaves releasing it to the caller", async () => {
    const conn = makeSerializedWriteConnection();
    const getConnection = vi.fn();
    vi.mocked(getPool).mockReturnValue({ getConnection } as any);

    const writeOp = vi.fn().mockResolvedValue('result');
    const result = await runSerializedCommandWrite('!test', { connection: conn as any }, writeOp);

    expect(result).toBe('result');
    expect(getConnection).not.toHaveBeenCalled();
    expect(writeOp).toHaveBeenCalledWith(conn);
    expect(conn.commit).toHaveBeenCalledOnce();
    // Its own trigger lock is still released; the connection itself is not.
    expect(conn.execute.mock.calls.some((call) => String(call[0]).startsWith('SELECT RELEASE_LOCK'))).toBe(true);
    expect(conn.release).not.toHaveBeenCalled();
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

  it('destroys rather than releases the connection when RELEASE_LOCK fails', async () => {
    const conn = { ...makeSerializedWriteConnection(), destroy: vi.fn() };
    const baseExecute = conn.execute.getMockImplementation()!;
    conn.execute.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT RELEASE_LOCK')) throw new Error('connection lost');
      return baseExecute(sql);
    });
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    await expect(runSerializedCommandWrite('!test', undefined, vi.fn().mockResolvedValue('ok'))).resolves.toBe('ok');
    expect(conn.destroy).toHaveBeenCalledOnce();
    expect(conn.release).not.toHaveBeenCalled();
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
