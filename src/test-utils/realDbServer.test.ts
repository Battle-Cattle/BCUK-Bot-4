import { describe, it, expect, vi } from 'vitest';

const createConnection = vi.fn();
vi.mock('mysql2/promise', () => ({ default: { createConnection: (...args: unknown[]) => createConnection(...args) } }));

import { dropTestDatabases, openTestServerConnection } from './realDbServer';

const SETTINGS = { host: '127.0.0.1', port: 3307, user: 'root', password: 'test' };

describe('openTestServerConnection', () => {
  it('connects with multi-statement queries, selecting the database when given', async () => {
    createConnection.mockResolvedValue('conn');

    expect(await openTestServerConnection(SETTINGS, 'bcuk_test_w1')).toBe('conn');
    expect(createConnection).toHaveBeenCalledWith({ ...SETTINGS, database: 'bcuk_test_w1', multipleStatements: true });
  });
});

describe('dropTestDatabases', () => {
  it('drops only the scratch databases', async () => {
    const query = vi.fn(async (sql: string) => sql === 'SHOW DATABASES'
      ? [[{ Database: 'bcuk' }, { Database: 'bcuk_test_w1' }, { Database: 'mysql' }, { Database: 'bcuk_test_w2' }], []]
      : [[], []]);

    expect(await dropTestDatabases({ query } as never)).toEqual(['bcuk_test_w1', 'bcuk_test_w2']);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['SHOW DATABASES', 'DROP DATABASE `bcuk_test_w1`', 'DROP DATABASE `bcuk_test_w2`']);
  });
});
