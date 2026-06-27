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

import { getPool, closePool } from './pool';

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
