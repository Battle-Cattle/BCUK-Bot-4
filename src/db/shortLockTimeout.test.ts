import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
const { logWarnSpy } = vi.hoisted(() => ({ logWarnSpy: vi.fn() }));
vi.mock('../shared/logger', () => ({ createLogger: () => ({ warn: logWarnSpy }) }));

import { makeMockConnection, makeMockPool } from '../test-utils/mockMysqlPool';
import { getPool } from './pool';
import { withShortLockTimeout } from './shortLockTimeout';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('withShortLockTimeout', () => {
  it('runs fn under a 5s lock wait, then resets it and releases the connection', async () => {
    const conn = makeMockConnection();
    vi.mocked(getPool).mockReturnValue(makeMockPool({ connection: conn }) as any);
    expect(await withShortLockTimeout(async (c) => { await c.execute('SELECT 1'); return 'done'; })).toBe('done');
    expect(conn.execute.mock.calls.map(([sql]) => sql)).toEqual([
      'SET SESSION innodb_lock_wait_timeout = 5', 'SELECT 1', 'SET SESSION innodb_lock_wait_timeout = DEFAULT',
    ]);
    expect(conn.release).toHaveBeenCalledOnce();
  });

  it('still resets and releases when fn throws', async () => {
    const conn = makeMockConnection();
    vi.mocked(getPool).mockReturnValue(makeMockPool({ connection: conn }) as any);
    await expect(withShortLockTimeout(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(conn.execute).toHaveBeenLastCalledWith('SET SESSION innodb_lock_wait_timeout = DEFAULT');
    expect(conn.release).toHaveBeenCalledOnce();
  });

  it('destroys the connection instead of releasing it when the reset fails', async () => {
    const conn = makeMockConnection();
    conn.execute.mockImplementation(async (sql: string) => {
      if (sql.endsWith('DEFAULT')) throw new Error('gone');
      return [[], []];
    });
    vi.mocked(getPool).mockReturnValue(makeMockPool({ connection: conn }) as any);
    expect(await withShortLockTimeout(async () => 1)).toBe(1);
    expect(conn.destroy).toHaveBeenCalledOnce();
    expect(conn.release).not.toHaveBeenCalled();
    expect(logWarnSpy).toHaveBeenCalledWith(expect.stringContaining('destroying connection'), expect.any(Error));
  });
});
