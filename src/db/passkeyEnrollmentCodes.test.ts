import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import {
  savePasskeyEnrollmentCode,
  consumePasskeyEnrollmentCode,
  deletePasskeyEnrollmentCode,
} from './passkeyEnrollmentCodes';
import { makeMockPool } from '../test-utils/mockMysqlPool';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('savePasskeyEnrollmentCode', () => {
  it('prunes expired codes, replaces the user\'s code past the cooldown, then inserts with DB-side times', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await savePasskeyEnrollmentCode('42', 'hash', 300, 60)).toBe(true);

    const calls = pool.execute.mock.calls as [string, unknown[]?][];
    expect(calls[0][0]).toContain('DELETE FROM passkey_enrollment_codes WHERE expires_at <= NOW()');
    expect(calls[1][0]).toContain('sent_at <= DATE_SUB(NOW(), INTERVAL ? SECOND)');
    expect(calls[1][1]).toEqual(['42', 60]);
    expect(calls[2][0]).toContain('INSERT INTO passkey_enrollment_codes');
    expect(calls[2][0]).toContain('DATE_ADD(NOW(), INTERVAL ? SECOND)');
    expect(calls[2][1]).toEqual(['42', 'hash', 300]);
  });

  it('reports a code sent within the cooldown (duplicate key) as not stored', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 0 }, []] });
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', errno: 1062 }));
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await savePasskeyEnrollmentCode('42', 'hash', 300, 60)).toBe(false);
  });

  it('rethrows other insert errors', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 0 }, []] });
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockRejectedValueOnce(new Error('db down'));
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(savePasskeyEnrollmentCode('42', 'hash', 300, 60)).rejects.toThrow('db down');
  });
});

describe('consumePasskeyEnrollmentCode', () => {
  it('spends an attempt, then consumes a matching code', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await consumePasskeyEnrollmentCode('42', 'hash', 5)).toBe('ok');

    const calls = pool.execute.mock.calls as [string, unknown[]][];
    expect(calls[0][0]).toContain('SET attempts = attempts + 1');
    expect(calls[0][0]).toContain('expires_at > NOW() AND attempts < ?');
    expect(calls[0][1]).toEqual(['42', 5]);
    expect(calls[1][0]).toContain('DELETE FROM passkey_enrollment_codes WHERE discord_id = ? AND code_hash = ?');
    expect(calls[1][1]).toEqual(['42', 'hash']);
  });

  it('reports a wrong code as invalid after spending the attempt', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }, []] });
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }, []]).mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await consumePasskeyEnrollmentCode('42', 'wrong', 5)).toBe('invalid');
  });

  it('reports a missing, expired or exhausted code as expired without comparing it', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 0 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await consumePasskeyEnrollmentCode('42', 'hash', 5)).toBe('expired');
    expect(pool.execute).toHaveBeenCalledTimes(1);
  });
});

describe('deletePasskeyEnrollmentCode', () => {
  it("deletes the user's outstanding code", async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await deletePasskeyEnrollmentCode('42');

    expect(pool.execute).toHaveBeenCalledWith('DELETE FROM passkey_enrollment_codes WHERE discord_id = ?', ['42']);
  });
});
