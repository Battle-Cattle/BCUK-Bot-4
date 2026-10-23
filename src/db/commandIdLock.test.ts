import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeMockPool } from '../test-utils/mockMysqlPool';

vi.mock('mysql2/promise', () => ({ default: {} }));
vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('./commandLocks', () => ({
  acquireNamedLock: vi.fn().mockResolvedValue(undefined),
  releaseNamedLock: vi.fn().mockResolvedValue(undefined),
}));

import { commandIdLockName, withCommandIdLock } from './commandIdLock';
import { getPool } from './pool';
import { acquireNamedLock, releaseNamedLock } from './commandLocks';

let pool: ReturnType<typeof makeMockPool>;

beforeEach(() => {
  vi.clearAllMocks();
  pool = makeMockPool();
  vi.mocked(getPool).mockReturnValue(pool as never);
});

describe('commandIdLockName', () => {
  it('names the lock after the command id', () => {
    expect(commandIdLockName(42)).toBe('bcuk_cmdid_42');
  });
});

describe('withCommandIdLock', () => {
  it('runs fn on the locked connection between acquire and release, then releases the connection', async () => {
    const order: string[] = [];
    vi.mocked(acquireNamedLock).mockImplementationOnce(async (_conn, name) => { order.push(`acquire:${name}`); });
    vi.mocked(releaseNamedLock).mockImplementationOnce(async (_conn, name) => { order.push(`release:${name}`); });
    pool._conn.release.mockImplementation(() => { order.push('connection.release'); });

    const result = await withCommandIdLock(7, async (connection) => {
      expect(connection).toBe(pool._conn);
      order.push('fn');
      return 'done';
    });

    expect(result).toBe('done');
    expect(order).toEqual(['acquire:bcuk_cmdid_7', 'fn', 'release:bcuk_cmdid_7', 'connection.release']);
    expect(vi.mocked(acquireNamedLock).mock.calls[0]![0]).toBe(pool._conn);
  });

  it('releases the lock and the connection when fn throws, and rethrows its error', async () => {
    const failure = new Error('write failed');

    await expect(withCommandIdLock(3, () => Promise.reject(failure))).rejects.toBe(failure);

    expect(releaseNamedLock).toHaveBeenCalledWith(pool._conn, 'bcuk_cmdid_3');
    expect(pool._conn.release).toHaveBeenCalledTimes(1);
  });

  it('releases the connection without running fn when the lock cannot be acquired', async () => {
    const timeout = new Error('Timed out acquiring command write lock');
    vi.mocked(acquireNamedLock).mockRejectedValueOnce(timeout);
    const fn = vi.fn();

    await expect(withCommandIdLock(3, fn)).rejects.toBe(timeout);

    expect(fn).not.toHaveBeenCalled();
    expect(releaseNamedLock).toHaveBeenCalledWith(pool._conn, 'bcuk_cmdid_3');
    expect(pool._conn.release).toHaveBeenCalledTimes(1);
  });
});
