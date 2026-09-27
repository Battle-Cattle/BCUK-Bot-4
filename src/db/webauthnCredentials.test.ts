import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
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
        { credential_id: 'a', transports: 'internal,hybrid' },
        { credential_id: 'b', transports: null },
      ],
    });
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await listPasskeyDescriptorsForUser('123')).toEqual([
      { credentialId: 'a', transports: ['internal', 'hybrid'] },
      { credentialId: 'b', transports: [] },
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
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 7,
      transports: ['internal'],
    });
  });
});

describe('insertPasskey', () => {
  it('stores the public key as a Buffer and joins transports', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    const stored = await insertPasskey({
      credentialId: 'cred1',
      discordId: '123',
      publicKey: new Uint8Array([9, 8]),
      signCount: 0,
      transports: ['internal', 'hybrid'],
      deviceLabel: 'Laptop',
    });

    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO webauthn_credentials');
    expect(params).toEqual(['cred1', '123', Buffer.from([9, 8]), 0, 'internal,hybrid', 'Laptop']);
    expect(stored).toBe(true);
  });

  it('returns false instead of throwing when the credential ID already exists', async () => {
    const pool = makeMockPool();
    pool.execute.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }));
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await insertPasskey({
      credentialId: 'c', discordId: '1', publicKey: new Uint8Array([1]), signCount: 0, transports: [], deviceLabel: 'x',
    })).toBe(false);
  });

  it('rethrows other database errors', async () => {
    const pool = makeMockPool();
    pool.execute.mockRejectedValueOnce(new Error('connection lost'));
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(insertPasskey({
      credentialId: 'c', discordId: '1', publicKey: new Uint8Array([1]), signCount: 0, transports: [], deviceLabel: 'x',
    })).rejects.toThrow('connection lost');
  });

  it('stores NULL transports when the authenticator reported none', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await insertPasskey({
      credentialId: 'c', discordId: '1', publicKey: new Uint8Array([1]), signCount: 0, transports: [], deviceLabel: 'x',
    });

    expect((pool.execute.mock.calls[0][1] as unknown[])[4]).toBeNull();
  });
});

describe('recordPasskeyUse', () => {
  it('updates the counter and last-used time for the credential', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await recordPasskeyUse('cred1', 5);

    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('last_used_at = NOW()');
    expect(params).toEqual([5, 'cred1']);
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
