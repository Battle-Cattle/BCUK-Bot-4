import { describe, it, expect, vi, beforeEach } from 'vitest';

const openTestServerConnection = vi.fn();
const dropTestDatabases = vi.fn();
vi.mock('./realDbServer', () => ({
  openTestServerConnection: (...args: unknown[]) => openTestServerConnection(...args),
  dropTestDatabases: (...args: unknown[]) => dropTestDatabases(...args),
}));

import setup from './realDb.globalSetup';

const ENV = { TEST_DB_HOST: '127.0.0.1', TEST_DB_PORT: '3307', TEST_DB_USER: 'root', TEST_DB_PASSWORD: 'test' };

describe('realDb global setup', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    dropTestDatabases.mockResolvedValue([]);
  });

  it('drops leftover scratch databases before the run and again in teardown', async () => {
    const conns = [{ end: vi.fn() }, { end: vi.fn() }];
    openTestServerConnection.mockResolvedValueOnce(conns[0]).mockResolvedValueOnce(conns[1]);

    const teardown = await setup();
    expect(openTestServerConnection).toHaveBeenCalledWith({ host: '127.0.0.1', port: 3307, user: 'root', password: 'test' });
    expect(dropTestDatabases).toHaveBeenCalledWith(conns[0]);
    expect(conns[0]!.end).toHaveBeenCalled();

    await teardown();
    expect(dropTestDatabases).toHaveBeenLastCalledWith(conns[1]);
    expect(conns[1]!.end).toHaveBeenCalled();
  });

  it('ends the connection even when dropping fails', async () => {
    const conn = { end: vi.fn() };
    openTestServerConnection.mockResolvedValue(conn);
    dropTestDatabases.mockRejectedValue(new Error('denied'));

    await expect(setup()).rejects.toThrow('denied');
    expect(conn.end).toHaveBeenCalled();
  });

  it('names the server when it cannot connect', async () => {
    openTestServerConnection.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(setup()).rejects.toThrow("Couldn't connect to the test MySQL server at 127.0.0.1:3307: connect ECONNREFUSED");
  });

  it('fails before connecting when the settings are missing', async () => {
    vi.stubEnv('TEST_DB_HOST', '');

    await expect(setup()).rejects.toThrow(/TEST_DB_HOST is not set/);
    expect(openTestServerConnection).not.toHaveBeenCalled();
  });
});
