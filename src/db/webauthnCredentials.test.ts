import { describe, it, expect, vi, beforeEach } from 'vitest';

// `withTransaction` is reimplemented (as in companionOAuthCodes.test.ts) so this test doesn't pull
// in pool.ts's real config import chain; it drives the same mocked `getPool().getConnection()`.
vi.mock('./pool', () => {
  const getPool = vi.fn();
  return {
    getPool,
    withTransaction: async (work: (conn: unknown) => Promise<unknown>) => {
      const conn = await getPool().getConnection();
      try {
        await conn.beginTransaction();
        const result = await work(conn);
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
  };
});
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import {
  listPasskeysForUser,
  listPasskeyDescriptorsForUser,
  findPasskey,
  insertPasskey,
  recordPasskeyUse,
  deletePasskey,
} from './webauthnCredentials';
import { makeMockPool } from '../test-utils/mockMysqlPool';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listPasskeysForUser', () => {
  it('maps rows to summaries without key material', async () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const pool = makeMockPool({
      rows: [{ credential_id: 'cred1', device_label: 'Phone', created_at: created, last_used_at: null }],
    });
    vi.mocked(getPool).mockReturnValue(pool as any);

    const result = await listPasskeysForUser('123');

    expect(result).toEqual([{ credentialId: 'cred1', deviceLabel: 'Phone', createdAt: created, lastUsedAt: null }]);
    expect(pool.execute.mock.calls[0][1]).toEqual(['123']);
    expect(pool.execute.mock.calls[0][0]).not.toContain('public_key');
  });
});

describe('listPasskeyDescriptorsForUser', () => {
  it('splits stored transports and treats NULL as none', async () => {
    const pool = makeMockPool({
      rows: [
        { credential_id: 'a', user_handle: 'h1', transports: 'internal,hybrid' },
        { credential_id: 'b', user_handle: 'h1', transports: null },
      ],
    });
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await listPasskeyDescriptorsForUser('123')).toEqual([
      { credentialId: 'a', userHandle: 'h1', transports: ['internal', 'hybrid'] },
      { credentialId: 'b', userHandle: 'h1', transports: [] },
    ]);
  });
});

describe('findPasskey', () => {
  it('returns null when no row matches', async () => {
    vi.mocked(getPool).mockReturnValue(makeMockPool() as any);
    expect(await findPasskey('missing')).toBeNull();
  });

  it('returns the stored passkey with the discord_id as a string and key as bytes', async () => {
    const pool = makeMockPool({
      rows: [{
        credential_id: 'cred1',
        discord_id: '900000000000000001',
        user_handle: 'handle-b64',
        public_key: Buffer.from([1, 2, 3]),
        sign_count: 7,
        transports: 'internal',
      }],
    });
    vi.mocked(getPool).mockReturnValue(pool as any);

    const result = await findPasskey('cred1');

    expect(result).toEqual({
      credentialId: 'cred1',
      discordId: '900000000000000001',
      userHandle: 'handle-b64',
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 7,
      transports: ['internal'],
    });
  });
});

describe('insertPasskey', () => {
  const NEW = {
    credentialId: 'cred1',
    discordId: '123',
    userHandle: 'handle-b64',
    publicKey: new Uint8Array([9, 8]),
    signCount: 0,
    transports: ['internal', 'hybrid'],
    deviceLabel: 'Laptop',
  };

  /** Builds a pool whose transaction connection answers the lock, then COUNT(*) with `count`, then the INSERT. */
  function poolWithCount(count: string, insert: () => Promise<unknown> = () => Promise.resolve([{ affectedRows: 1 }, []])) {
    const pool = makeMockPool();
    pool._conn.execute
      .mockResolvedValueOnce([[{ discord_id: '123' }], []])
      .mockResolvedValueOnce([[{ count }], []])
      .mockImplementationOnce(insert);
    vi.mocked(getPool).mockReturnValue(pool as any);
    return pool;
  }

  it('locks the user row, counts, then inserts inside one transaction', async () => {
    const pool = poolWithCount('2');

    expect(await insertPasskey(NEW, 10)).toBe('inserted');

    const calls = pool._conn.execute.mock.calls as [string, unknown[]][];
    expect(calls[0][0]).toContain('FOR UPDATE');
    expect(calls[0][1]).toEqual(['123']);
    expect(calls[1][0]).toContain('COUNT(*)');
    expect(calls[2][0]).toContain('INSERT INTO webauthn_credentials');
    expect(calls[2][1]).toEqual(['cred1', '123', 'handle-b64', Buffer.from([9, 8]), 0, 'internal,hybrid', 'Laptop']);
    expect(pool._conn.commit).toHaveBeenCalledTimes(1);
  });

  it("returns 'limit' without inserting once the user has maxPerUser passkeys", async () => {
    const pool = poolWithCount('10');

    expect(await insertPasskey(NEW, 10)).toBe('limit');
    expect(pool._conn.execute).toHaveBeenCalledTimes(2);
  });

  it("returns 'duplicate' and rolls back when the credential ID already exists", async () => {
    const pool = poolWithCount('0', () => Promise.reject(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' })));

    expect(await insertPasskey(NEW, 10)).toBe('duplicate');
    expect(pool._conn.rollback).toHaveBeenCalledTimes(1);
    expect(pool._conn.release).toHaveBeenCalledTimes(1);
  });

  it('rethrows other database errors', async () => {
    poolWithCount('0', () => Promise.reject(new Error('connection lost')));

    await expect(insertPasskey(NEW, 10)).rejects.toThrow('connection lost');
  });

  it('stores NULL transports when the authenticator reported none', async () => {
    const pool = poolWithCount('0');

    await insertPasskey({ ...NEW, transports: [] }, 10);

    expect((pool._conn.execute.mock.calls[2][1] as unknown[])[5]).toBeNull();
  });
});

describe('recordPasskeyUse', () => {
  it('accepts only a strictly higher counter (or 0 on a counterless authenticator) and stamps last-used time', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(recordPasskeyUse('cred1', 5)).resolves.toBe(true);

    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SET sign_count = ?, last_used_at = NOW()');
    expect(sql).toContain('WHERE credential_id = ? AND (sign_count < ? OR (? = 0 AND sign_count = 0))');
    expect(params).toEqual([5, 'cred1', 5, 5]);
  });

  it('reports a stale counter or a deleted passkey as not accepted', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 0 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(recordPasskeyUse('cred1', 5)).resolves.toBe(false);
  });
});

describe('deletePasskey', () => {
  it('scopes the delete to the owning user and reports whether a row was removed', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await deletePasskey('123', 'cred1')).toBe(true);
    expect(pool.execute.mock.calls[0][1]).toEqual(['123', 'cred1']);
  });

  it('returns false when the user has no passkey with that ID', async () => {
    vi.mocked(getPool).mockReturnValue(makeMockPool({ executeResult: [{ affectedRows: 0 }, []] }) as any);
    expect(await deletePasskey('123', 'someone-elses')).toBe(false);
  });
});
