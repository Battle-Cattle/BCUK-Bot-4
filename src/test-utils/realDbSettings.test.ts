import { describe, it, expect } from 'vitest';
import { appEnvFor, clearTablesSql, readTestDbSettings, testDatabasesIn, workerDatabaseName } from './realDbSettings';

const FULL_ENV = { TEST_DB_HOST: ' 127.0.0.1 ', TEST_DB_PORT: '3307', TEST_DB_USER: 'root', TEST_DB_PASSWORD: 'test' };

describe('readTestDbSettings', () => {
  it('reads the TEST_DB_* settings', () => {
    expect(readTestDbSettings(FULL_ENV)).toEqual({ host: '127.0.0.1', port: 3307, user: 'root', password: 'test' });
  });

  it('defaults the port to 3306 and accepts an empty password', () => {
    expect(readTestDbSettings({ ...FULL_ENV, TEST_DB_PORT: ' ', TEST_DB_PASSWORD: '' })).toMatchObject({ port: 3306, password: '' });
  });

  it('names every missing setting and how to start a server', () => {
    expect(() => readTestDbSettings({})).toThrow(
      /TEST_DB_HOST, TEST_DB_USER, TEST_DB_PASSWORD are not set\. Start one with `docker compose -f docker-compose\.test-db\.yml/,
    );
    expect(() => readTestDbSettings({ ...FULL_ENV, TEST_DB_USER: ' ' })).toThrow(/TEST_DB_USER is not set/);
  });

  it.each(['0', '65536', '33o6', '3306.5'])('rejects TEST_DB_PORT=%s', (port) => {
    expect(() => readTestDbSettings({ ...FULL_ENV, TEST_DB_PORT: port })).toThrow(`Invalid TEST_DB_PORT: must be a whole number from 1 to 65535, got '${port}'`);
  });
});

describe('workerDatabaseName', () => {
  it('names the database after the worker', () => {
    expect(workerDatabaseName('3')).toBe('bcuk_test_w3');
  });

  it.each([undefined, '', '0', '1; DROP DATABASE x'])('rejects VITEST_POOL_ID=%s', (poolId) => {
    expect(() => workerDatabaseName(poolId)).toThrow(/Expected VITEST_POOL_ID/);
  });
});

describe('testDatabasesIn', () => {
  it('keeps only the scratch databases', () => {
    expect(testDatabasesIn(['bcuk_test_w1', 'bcuk', 'mysql', 'bcuk_testing', 'bcuk_test_w12'])).toEqual(['bcuk_test_w1', 'bcuk_test_w12']);
  });
});

describe('appEnvFor', () => {
  it("points the app's DB settings at the test server and fills the other required ones", () => {
    const env = appEnvFor({ host: 'h', port: 3307, user: 'u', password: 'p' }, 'bcuk_test_w1');
    expect(env).toMatchObject({ DB_HOST: 'h', DB_PORT: '3307', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'bcuk_test_w1', LOG_LEVEL: 'warn' });
    expect(env.SESSION_SECRET!.length).toBeGreaterThanOrEqual(32);
    for (const name of ['DISCORD_TOKEN', 'TWITCH_USERNAME', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_CALLBACK_URL']) {
      expect(env[name]).toBeTruthy();
    }
  });
});

describe('clearTablesSql', () => {
  it('deletes from every table with foreign-key checks off', () => {
    expect(clearTablesSql(['user', 'odd`name'])).toBe('SET FOREIGN_KEY_CHECKS = 0; DELETE FROM `user`; DELETE FROM `odd``name`; SET FOREIGN_KEY_CHECKS = 1;');
  });

  it('is empty when there are no tables', () => {
    expect(clearTablesSql([])).toBe('');
  });
});
