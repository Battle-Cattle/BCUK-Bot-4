import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import { saveWebauthnChallenge, consumeWebauthnChallenge } from './webauthnChallenges';
import { makeMockPool } from '../test-utils/mockMysqlPool';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('saveWebauthnChallenge', () => {
  it('prunes expired challenges, then inserts with a DB-side expiry', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await saveWebauthnChallenge('chal', 'login', 300);

    const calls = pool.execute.mock.calls as [string, unknown[]?][];
    expect(calls[0]![0]).toContain('DELETE FROM webauthn_challenges WHERE expires_at <= NOW()');
    expect(calls[1]![0]).toContain('INSERT INTO webauthn_challenges');
    expect(calls[1]![0]).toContain('DATE_ADD(NOW(), INTERVAL ? SECOND)');
    expect(calls[1]![1]).toEqual(['chal', 'login', 300]);
  });
});

describe('consumeWebauthnChallenge', () => {
  it('consumes an unexpired challenge for the purpose with one conditional DELETE', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await consumeWebauthnChallenge('chal', 'register')).toBe(true);

    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM webauthn_challenges');
    expect(sql).toContain('purpose = ?');
    expect(sql).toContain('expires_at > NOW()');
    expect(params).toEqual(['chal', 'register']);
  });

  it('returns false when nothing matched (unknown, expired, wrong purpose or already consumed)', async () => {
    vi.mocked(getPool).mockReturnValue(makeMockPool({ executeResult: [{ affectedRows: 0 }, []] }) as any);
    expect(await consumeWebauthnChallenge('chal', 'login')).toBe(false);
  });
});
