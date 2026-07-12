import { describe, it, expect, vi, beforeEach } from 'vitest';

// `withTransaction` is reimplemented here (rather than via `importOriginal`) so this
// test doesn't pull in pool.ts's real `../shared/config` import chain, which throws
// in a test environment with no DISCORD_TOKEN etc. set. The logic mirrors pool.ts's
// real implementation exactly, driven by the same mocked `getPool()`.
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
import { createCode, consumeCode, exchangeCodeForToken } from './companionOAuthCodes';
import { createHash } from 'crypto';
import { makeMockConnection } from '../test-utils/mockMysqlPool';

/** Hashes a string with SHA-256 and returns it as a hex digest, matching the stored-code hashing scheme. */
function sha256hex(s: string) {
  return createHash('sha256').update(s).digest('hex');
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── createCode ───────────────────────────────────────────────────────────────

describe('createCode', () => {
  it('inserts a hashed code with an expiry and returns the plaintext', async () => {
    const execute = vi.fn().mockResolvedValue([{}]);
    vi.mocked(getPool).mockReturnValue({ execute } as any);
    const plain = await createCode('123');
    expect(plain).toMatch(/^[0-9a-f]{48}$/); // 24 bytes as hex
    const [sql, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO companion_oauth_codes');
    expect(sql).toContain('DATE_ADD(NOW(), INTERVAL ? SECOND)');
    expect(params[0]).toBe(sha256hex(plain));
    expect(params[1]).toBe('123');
    expect(params[2]).toBe(60);
  });
});

// ─── consumeCode ──────────────────────────────────────────────────────────────

describe('consumeCode', () => {
  it('returns null when the UPDATE affects no rows (invalid/expired/used code)', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 0 }]);
    vi.mocked(getPool).mockReturnValue({ execute } as any);
    const result = await consumeCode('bad-code');
    expect(result).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1); // no follow-up SELECT
  });

  it('returns the discord_id when the UPDATE succeeds and a row is found', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ discord_id: '42' }]]);
    vi.mocked(getPool).mockReturnValue({ execute } as any);
    const result = await consumeCode('good-code');
    expect(result).toBe('42');
    const [updateSql] = execute.mock.calls[0] as [string, unknown[]];
    expect(updateSql).toContain('used_at IS NULL AND expires_at > NOW()');
  });

  it('returns null if the follow-up SELECT somehow finds no row', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[]]);
    vi.mocked(getPool).mockReturnValue({ execute } as any);
    const result = await consumeCode('good-code');
    expect(result).toBeNull();
  });

  it('hashes the same code identically across calls, preventing double-spend via the affectedRows guard', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ discord_id: '1' }]])
      .mockResolvedValueOnce([{ affectedRows: 0 }]); // second consume of the same code fails
    vi.mocked(getPool).mockReturnValue({ execute } as any);
    const first = await consumeCode('reused-code');
    const second = await consumeCode('reused-code');
    expect(first).toBe('1');
    expect(second).toBeNull();
  });
});

// ─── exchangeCodeForToken ───────────────────────────────────────────────────

const buildConn = makeMockConnection;

describe('exchangeCodeForToken', () => {
  it('rolls back and returns null when the UPDATE affects no rows (invalid/expired/used code)', async () => {
    const conn = buildConn({ execute: vi.fn().mockResolvedValue([{ affectedRows: 0 }]) });
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    const result = await exchangeCodeForToken('bad-code');

    expect(result).toBeNull();
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and returns null if the follow-up SELECT finds no row', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[]]);
    const conn = buildConn({ execute });
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    const result = await exchangeCodeForToken('good-code');

    expect(result).toBeNull();
    expect(conn.rollback).toHaveBeenCalledTimes(1);
  });

  it('commits and returns a plaintext token when the code is valid', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ discord_id: '42' }]])
      .mockResolvedValueOnce([{}]);
    const conn = buildConn({ execute });
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    const token = await exchangeCodeForToken('good-code');

    expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 bytes as hex
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
    const [tokenSql, tokenParams] = execute.mock.calls[2] as [string, unknown[]];
    expect(tokenSql).toContain('INSERT INTO companion_app_tokens');
    expect(tokenParams[0]).toBe('42');
  });

  it('rolls back and rethrows if issuing the token fails, leaving the code unconsumed for retry', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ discord_id: '42' }]])
      .mockRejectedValueOnce(new Error('insert failed'));
    const conn = buildConn({ execute });
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    await expect(exchangeCodeForToken('good-code')).rejects.toThrow('insert failed');

    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });
});
