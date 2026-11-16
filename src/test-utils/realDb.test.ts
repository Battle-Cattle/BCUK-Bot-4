import { describe, it, expect, vi } from 'vitest';

const runMigrations = vi.fn();
vi.mock('../db', () => ({ runMigrations: () => runMigrations(), closePool: vi.fn() }));
const openTestServerConnection = vi.fn();
vi.mock('./realDbServer', () => ({ openTestServerConnection: (...args: unknown[]) => openTestServerConnection(...args) }));

import { prepareWorkerDatabase, workerDatabase } from './realDb';

// prepareWorkerDatabase's failure path, with the server mocked. Its success path runs against a
// real MySQL in realDb.db.test.ts (npm run test:db).

const ENV = { TEST_DB_HOST: '127.0.0.1', TEST_DB_USER: 'root', TEST_DB_PASSWORD: 'test', VITEST_POOL_ID: '1' };

describe('prepareWorkerDatabase', () => {
  it('closes its connection and rethrows when preparation fails after connecting', async () => {
    const conn = { query: vi.fn().mockResolvedValue([[], []]), end: vi.fn().mockRejectedValue(new Error('already closed')) };
    openTestServerConnection.mockResolvedValue(conn);
    runMigrations.mockRejectedValue(new Error('Migration 0002 failed'));

    await expect(prepareWorkerDatabase(ENV)).rejects.toThrow('Migration 0002 failed');
    expect(conn.end).toHaveBeenCalled();
    expect(() => workerDatabase()).toThrow(/No worker database/);
  });
});
