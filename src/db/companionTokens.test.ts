import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import { issueToken, findDiscordIdByTokenHash, getTokenStatus, revokeToken } from './companionTokens';
import { createHash } from 'crypto';
import { makeMockPool } from '../test-utils/mockMysqlPool';

/** Builds a fake mysql pool whose `execute`/`query` resolve to the given rows. */
function makePool(rows: unknown[] = []) {
  return makeMockPool({ rows });
}

/** Hashes a string with SHA-256 and returns it as a hex digest, matching the stored-token hashing scheme. */
function sha256hex(s: string) {
  return createHash('sha256').update(s).digest('hex');
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── issueToken ───────────────────────────────────────────────────────────────

describe('issueToken', () => {
  it('inserts a hashed token and returns the plaintext', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    const plain = await issueToken('123');
    expect(plain).toMatch(/^[0-9a-f]{64}$/); // 32 bytes as hex
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO companion_app_tokens');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(params[0]).toBe('123');
    expect(params[1]).toBe(sha256hex(plain));
  });
});

// ─── findDiscordIdByTokenHash ─────────────────────────────────────────────────

describe('findDiscordIdByTokenHash', () => {
  it('returns null when no rows found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const result = await findDiscordIdByTokenHash('a'.repeat(64));
    expect(result).toBeNull();
  });

  it('returns null when stored hash does not match incoming hash', async () => {
    const incoming = 'aa'.repeat(32);
    const stored = 'bb'.repeat(32);
    const row = { discord_id: '1', key_hash: stored };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await findDiscordIdByTokenHash(incoming);
    expect(result).toBeNull();
  });

  it('returns null when stored and incoming hash have different lengths', async () => {
    const incoming = 'ab'.repeat(32);
    const stored = 'ab'.repeat(16);
    const row = { discord_id: '1', key_hash: stored };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await findDiscordIdByTokenHash(incoming);
    expect(result).toBeNull();
  });

  it('returns the discord_id when hash matches', async () => {
    const hash = sha256hex('mysecrettoken');
    const row = { discord_id: '42', key_hash: hash };
    const pool = makePool([row]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await findDiscordIdByTokenHash(hash);
    expect(result).toBe('42');
    const [sql] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('revoked_at IS NULL');
  });
});

// ─── getTokenStatus ───────────────────────────────────────────────────────────

describe('getTokenStatus', () => {
  it('returns null when no rows found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const result = await getTokenStatus('999');
    expect(result).toBeNull();
  });

  it('reports hasToken=true when revoked_at is null', async () => {
    const now = new Date();
    const row = { created_at: now, revoked_at: null };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await getTokenStatus('1');
    expect(result).toEqual({ hasToken: true, createdAt: now });
  });

  it('reports hasToken=false when revoked_at is set', async () => {
    const row = { created_at: new Date(), revoked_at: new Date() };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await getTokenStatus('1');
    expect(result!.hasToken).toBe(false);
  });
});

// ─── revokeToken ──────────────────────────────────────────────────────────────

describe('revokeToken', () => {
  it('executes UPDATE setting revoked_at for the given discord ID', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await revokeToken('123');
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SET revoked_at = NOW()');
    expect(params).toContain('123');
  });
});
