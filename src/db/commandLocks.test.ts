import { describe, it, expect, vi } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import {
  isDeadlockError,
  getCommandWriteLockName,
  getSortedCommandLockNames,
  acquireNamedLock,
  releaseNamedLock,
  runWithDeadlockRetry,
  MAX_DEADLOCK_RETRIES,
} from './commandLocks';
import { makeMockConnection } from '../test-utils/mockMysqlPool';

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
    await expect(acquireNamedLock(makeConn('0') as any, 'bcuk_cmd_abc123')).rejects.toThrow('bcuk_cmd_abc123');
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

describe('releaseNamedLock', () => {
  it('runs RELEASE_LOCK and leaves the connection alive on success', async () => {
    const conn = makeMockConnection();
    await expect(releaseNamedLock(conn as any, 'lock_a')).resolves.toBeUndefined();
    expect(conn.execute).toHaveBeenCalledWith('SELECT RELEASE_LOCK(?)', ['lock_a']);
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it('destroys the connection (instead of letting it go back to the pool) when RELEASE_LOCK fails', async () => {
    const conn = makeMockConnection({ execute: vi.fn().mockRejectedValue(new Error('connection lost')) });
    await expect(releaseNamedLock(conn as any, 'lock_a')).resolves.toBeUndefined();
    expect(conn.destroy).toHaveBeenCalledOnce();
    expect(conn.release).not.toHaveBeenCalled();
  });
});

describe('getSortedCommandLockNames', () => {
  it('orders lock names by command, whatever order the commands arrive in', () => {
    const expected = ['!a', '!b', '!c'].map(getCommandWriteLockName);
    expect(getSortedCommandLockNames(['!c', '!a', '!b'])).toEqual(expected);
    expect(getSortedCommandLockNames(['!b', '!c', '!a'])).toEqual(expected);
  });

  it('keeps duplicates and does not mutate the input', () => {
    const commands = ['!b', '!a', '!b'];
    expect(getSortedCommandLockNames(commands)).toEqual(['!a', '!b', '!b'].map(getCommandWriteLockName));
    expect(commands).toEqual(['!b', '!a', '!b']);
  });
});

describe('runWithDeadlockRetry', () => {
  const deadlock = () => Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' });

  it('commits and returns the body result on the first attempt', async () => {
    const conn = makeMockConnection();
    const body = vi.fn().mockResolvedValue('done');

    await expect(runWithDeadlockRetry(conn as any, 'test', body)).resolves.toBe('done');
    expect(body).toHaveBeenCalledWith(0);
    expect(conn.commit).toHaveBeenCalledOnce();
    expect(conn.rollback).not.toHaveBeenCalled();
  });

  it('rolls back and retries after a deadlock, passing the attempt index', async () => {
    const conn = makeMockConnection();
    const body = vi.fn().mockRejectedValueOnce(deadlock()).mockResolvedValueOnce('second time');

    await expect(runWithDeadlockRetry(conn as any, 'test', body)).resolves.toBe('second time');
    expect(body.mock.calls).toEqual([[0], [1]]);
    expect(conn.rollback).toHaveBeenCalledOnce();
    expect(conn.commit).toHaveBeenCalledOnce();
  });

  it('rethrows a non-deadlock error straight away, without retrying', async () => {
    const conn = makeMockConnection();
    const err = new Error('duplicate entry');
    const body = vi.fn().mockRejectedValue(err);

    await expect(runWithDeadlockRetry(conn as any, 'test', body, 'gave up')).rejects.toBe(err);
    expect(body).toHaveBeenCalledOnce();
    expect(conn.rollback).toHaveBeenCalledOnce();
  });

  it('rethrows the last deadlock error once retries run out when no exhausted message is given', async () => {
    const conn = makeMockConnection();
    const last = deadlock();
    const body = vi.fn().mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(deadlock()).mockRejectedValue(last);

    await expect(runWithDeadlockRetry(conn as any, 'test', body)).rejects.toBe(last);
    expect(body).toHaveBeenCalledTimes(MAX_DEADLOCK_RETRIES);
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('throws the exhausted message, with the deadlock as its cause, once retries run out', async () => {
    const conn = makeMockConnection();
    const last = deadlock();
    const body = vi.fn().mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(deadlock()).mockRejectedValue(last);

    const error = await runWithDeadlockRetry(conn as any, 'test', body, 'Command is busy, try again').catch((e: unknown) => e);
    expect(error).toMatchObject({ message: 'Command is busy, try again', cause: last });
    expect(body).toHaveBeenCalledTimes(MAX_DEADLOCK_RETRIES);
  });
});
