import { describe, it, expect, vi, beforeEach } from 'vitest';

const createPool = vi.fn();
vi.mock('mysql2/promise', () => ({ default: { createPool: (...args: unknown[]) => createPool(...args) } }));
vi.mock('../shared/config', () => ({
  DB_HOST: 'test-host',
  DB_PORT: 1234,
  DB_USER: 'test-user',
  DB_PASSWORD: 'test-password',
  DB_NAME: 'test-db',
}));

import { getPool, closePool, withTransaction, withTransactionOrNotFound, runInTransaction } from './pool';

beforeEach(async () => {
  vi.clearAllMocks();
  createPool.mockReturnValue({ end: vi.fn().mockResolvedValue(undefined) });
  // Reset the module-level singleton between tests.
  await closePool();
});

describe('getPool', () => {
  it('creates a pool with the configured connection settings', () => {
    getPool();
    expect(createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'test-host',
        port: 1234,
        user: 'test-user',
        password: 'test-password',
        database: 'test-db',
      }),
    );
  });

  it('enables bigNumberStrings so BIGINT columns surface as strings', () => {
    getPool();
    expect(createPool).toHaveBeenCalledWith(
      expect.objectContaining({ supportBigNumbers: true, bigNumberStrings: true }),
    );
  });

  it('enables TCP keepalive so a silently dead connection is detected and evicted', () => {
    getPool();
    expect(createPool).toHaveBeenCalledWith(
      expect.objectContaining({ enableKeepAlive: true, keepAliveInitialDelay: 10_000 }),
    );
  });

  it('returns the same pool instance on repeated calls (singleton)', () => {
    const first = getPool();
    const second = getPool();
    expect(second).toBe(first);
    expect(createPool).toHaveBeenCalledTimes(1);
  });
});

describe('closePool', () => {
  it('ends the existing pool', async () => {
    const mockPool = { end: vi.fn().mockResolvedValue(undefined) };
    createPool.mockReturnValue(mockPool);
    getPool();
    await closePool();
    expect(mockPool.end).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no pool has been created yet', async () => {
    await expect(closePool()).resolves.toBeUndefined();
  });

  it('allows a fresh pool to be created after closing', async () => {
    getPool();
    await closePool();
    getPool();
    expect(createPool).toHaveBeenCalledTimes(2);
  });
});

describe('withTransaction', () => {
  /** Builds a fake pool connection whose lifecycle methods resolve successfully. */
  function makeConn() {
    return {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
  }

  it('begins, runs work, commits, releases, and returns the work result', async () => {
    const conn = makeConn();
    createPool.mockReturnValue({ end: vi.fn(), getConnection: vi.fn().mockResolvedValue(conn) });
    const work = vi.fn().mockResolvedValue('the-result');

    const result = await withTransaction(work);

    expect(result).toBe('the-result');
    expect(conn.beginTransaction).toHaveBeenCalledOnce();
    expect(work).toHaveBeenCalledWith(conn);
    expect(conn.commit).toHaveBeenCalledOnce();
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledOnce();
  });

  it('rolls back, releases, and rethrows when work throws', async () => {
    const conn = makeConn();
    createPool.mockReturnValue({ end: vi.fn(), getConnection: vi.fn().mockResolvedValue(conn) });
    const boom = new Error('boom');

    await expect(withTransaction(async () => { throw boom; })).rejects.toBe(boom);

    expect(conn.rollback).toHaveBeenCalledOnce();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledOnce();
  });

  it('swallows a rollback failure and still rethrows the original error', async () => {
    const conn = makeConn();
    conn.rollback.mockRejectedValue(new Error('rollback failed'));
    createPool.mockReturnValue({ end: vi.fn(), getConnection: vi.fn().mockResolvedValue(conn) });
    const original = new Error('original failure');

    await expect(withTransaction(async () => { throw original; })).rejects.toBe(original);

    expect(conn.release).toHaveBeenCalledOnce();
  });

  it('releases the connection even when commit throws', async () => {
    const conn = makeConn();
    conn.commit.mockRejectedValue(new Error('commit failed'));
    createPool.mockReturnValue({ end: vi.fn(), getConnection: vi.fn().mockResolvedValue(conn) });

    await expect(withTransaction(async () => 'value')).rejects.toThrow('commit failed');

    expect(conn.rollback).toHaveBeenCalledOnce();
    expect(conn.release).toHaveBeenCalledOnce();
  });
});

describe('runInTransaction', () => {
  /** Builds a fake pool connection whose lifecycle methods resolve successfully. */
  function makeConn() {
    return {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
  }

  it('begins, runs work, commits, and returns the work result, without touching release', async () => {
    const conn = makeConn();
    const work = vi.fn().mockResolvedValue('the-result');

    const result = await runInTransaction(conn as any, work);

    expect(result).toBe('the-result');
    expect(conn.beginTransaction).toHaveBeenCalledOnce();
    expect(work).toHaveBeenCalledOnce();
    expect(conn.commit).toHaveBeenCalledOnce();
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).not.toHaveBeenCalled();
  });

  it('rolls back and rethrows when work throws, without releasing the connection', async () => {
    const conn = makeConn();
    const boom = new Error('boom');

    await expect(runInTransaction(conn as any, async () => { throw boom; })).rejects.toBe(boom);

    expect(conn.rollback).toHaveBeenCalledOnce();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).not.toHaveBeenCalled();
  });

  it('swallows a rollback failure and still rethrows the original error', async () => {
    const conn = makeConn();
    conn.rollback.mockRejectedValue(new Error('rollback failed'));
    const original = new Error('original failure');

    await expect(runInTransaction(conn as any, async () => { throw original; })).rejects.toBe(original);
  });
});

describe('withTransactionOrNotFound', () => {
  /** Builds a fake pool connection whose lifecycle methods resolve successfully. */
  function makeConn() {
    return {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
  }

  it('returns the work result on success, committing like withTransaction', async () => {
    const conn = makeConn();
    createPool.mockReturnValue({ end: vi.fn(), getConnection: vi.fn().mockResolvedValue(conn) });

    const result = await withTransactionOrNotFound(async () => 'the-result');

    expect(result).toBe('the-result');
    expect(conn.commit).toHaveBeenCalledOnce();
    expect(conn.rollback).not.toHaveBeenCalled();
  });

  it('rolls back and resolves to null when work calls notFound()', async () => {
    const conn = makeConn();
    createPool.mockReturnValue({ end: vi.fn(), getConnection: vi.fn().mockResolvedValue(conn) });

    const result = await withTransactionOrNotFound(async (_conn, notFound) => {
      notFound();
    });

    expect(result).toBeNull();
    expect(conn.rollback).toHaveBeenCalledOnce();
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('rolls back and rethrows any other error, without treating it as not-found', async () => {
    const conn = makeConn();
    createPool.mockReturnValue({ end: vi.fn(), getConnection: vi.fn().mockResolvedValue(conn) });
    const boom = new Error('boom');

    await expect(withTransactionOrNotFound(async () => { throw boom; })).rejects.toBe(boom);

    expect(conn.rollback).toHaveBeenCalledOnce();
  });

  it('does not confuse two concurrent calls not-found signals with each other', async () => {
    const connA = makeConn();
    const connB = makeConn();
    const getConnection = vi.fn()
      .mockResolvedValueOnce(connA)
      .mockResolvedValueOnce(connB);
    createPool.mockReturnValue({ end: vi.fn(), getConnection });

    const [resultA, resultB] = await Promise.all([
      withTransactionOrNotFound(async (_conn, notFound) => { notFound(); }),
      withTransactionOrNotFound(async () => 'found-it'),
    ]);

    expect(resultA).toBeNull();
    expect(resultB).toBe('found-it');
  });
});
