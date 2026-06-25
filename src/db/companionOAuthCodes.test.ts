import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import { createCode, consumeCode } from './companionOAuthCodes';
import { createHash } from 'crypto';

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
    expect(params[0]).toBe(sha256hex(plain));
    expect(params[1]).toBe('123');
    expect(params[2]).toBeInstanceOf(Date);
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
