import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));

import { getPool } from './pool';
import { pingDb } from './health';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pingDb', () => {
  it('returns true when a connection can be acquired and pinged', async () => {
    const conn = { ping: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);
    expect(await pingDb()).toBe(true);
    expect(conn.ping).toHaveBeenCalledOnce();
    expect(conn.release).toHaveBeenCalledOnce();
  });

  it('returns false when acquiring a connection fails', async () => {
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockRejectedValue(new Error('down')) } as any);
    expect(await pingDb()).toBe(false);
  });

  it('returns false when the ping itself fails', async () => {
    const conn = { ping: vi.fn().mockRejectedValue(new Error('timeout')), release: vi.fn() };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);
    expect(await pingDb()).toBe(false);
  });

  it('still releases the connection back to the pool when the ping rejects', async () => {
    const conn = { ping: vi.fn().mockRejectedValue(new Error('timeout')), release: vi.fn() };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);
    expect(await pingDb()).toBe(false);
    expect(conn.release).toHaveBeenCalledOnce();
  });
});
