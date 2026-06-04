import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));
vi.mock('./users', () => ({
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
}));

import { getPool } from './pool';
import {
  findApprovedKeyByHash,
  getApiKeyStatus,
  approveApiKey,
  denyApiKey,
  revokeApiKey,
  getPendingRequests,
  getAllApiKeys,
  requestApiKey,
} from './streamdeckKeys';
import { createHash } from 'crypto';

function makePool(rows: unknown[] = []) {
  return { execute: vi.fn().mockResolvedValue([[...rows], []]) };
}

function sha256hex(s: string) {
  return createHash('sha256').update(s).digest('hex');
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── findApprovedKeyByHash ────────────────────────────────────────────────────

describe('findApprovedKeyByHash', () => {
  it('returns null when no rows found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const result = await findApprovedKeyByHash('a'.repeat(64));
    expect(result).toBeNull();
  });

  it('returns null when stored hash does not match incoming hash', async () => {
    const incoming = 'aa'.repeat(32); // 64 hex chars
    const stored = 'bb'.repeat(32);   // different 64 hex chars
    const row = { discord_id: '1', key_hash: stored, status: 'approved', requested_at: new Date(), approved_at: null, approved_by: null };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await findApprovedKeyByHash(incoming);
    expect(result).toBeNull();
  });

  it('returns the mapped row when hash matches', async () => {
    const hash = sha256hex('mysecretkey');
    const row = { discord_id: '42', key_hash: hash, status: 'approved', requested_at: new Date(), approved_at: new Date(), approved_by: '1' };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await findApprovedKeyByHash(hash);
    expect(result).not.toBeNull();
    expect(result!.discord_id).toBe('42');
    expect(result!.status).toBe('approved');
  });

  it('returns null when stored and incoming hash have different lengths', async () => {
    const incoming = 'ab'.repeat(32); // 64 chars
    const stored = 'ab'.repeat(16);   // 32 chars — different length
    const row = { discord_id: '1', key_hash: stored, status: 'approved', requested_at: new Date(), approved_at: null, approved_by: null };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await findApprovedKeyByHash(incoming);
    expect(result).toBeNull();
  });
});

// ─── getApiKeyStatus ──────────────────────────────────────────────────────────

describe('getApiKeyStatus', () => {
  it('returns null when no rows found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const result = await getApiKeyStatus('999');
    expect(result).toBeNull();
  });

  it('maps a row with all fields', async () => {
    const now = new Date();
    const row = {
      discord_id: '123',
      status: 'pending',
      requested_at: now,
      approved_at: null,
      approved_by: null,
      user_name: null,
      approver_name: null,
    };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await getApiKeyStatus('123');
    expect(result!.discord_id).toBe('123');
    expect(result!.status).toBe('pending');
    expect(result!.requested_at).toBe(now);
    expect(result!.approved_at).toBeNull();
    expect(result!.approved_by).toBeNull();
  });

  it('maps a row with approver info', async () => {
    const row = {
      discord_id: '1',
      status: 'approved',
      requested_at: new Date(),
      approved_at: new Date(),
      approved_by: '99',
      user_name: 'Alice',
      approver_name: 'Admin',
    };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await getApiKeyStatus('1');
    expect(result!.approved_by).toBe('99');
    expect(result!.user_name).toBe('Alice');
    expect(result!.approver_name).toBe('Admin');
  });
});

// ─── approveApiKey ────────────────────────────────────────────────────────────

describe('approveApiKey', () => {
  it('executes UPDATE with approvedBy and discordId', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await approveApiKey('user1', 'admin1');
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'approved'");
    expect(params).toContain('admin1');
    expect(params).toContain('user1');
  });
});

// ─── denyApiKey ───────────────────────────────────────────────────────────────

describe('denyApiKey', () => {
  it('executes UPDATE setting status to denied', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await denyApiKey('user1');
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'denied'");
    expect(params).toContain('user1');
  });
});

// ─── revokeApiKey ─────────────────────────────────────────────────────────────

describe('revokeApiKey', () => {
  it('executes UPDATE setting status to revoked', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await revokeApiKey('user1');
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'revoked'");
    expect(params).toContain('user1');
  });
});

// ─── getPendingRequests ───────────────────────────────────────────────────────

describe('getPendingRequests', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const result = await getPendingRequests();
    expect(result).toEqual([]);
  });

  it('maps pending rows', async () => {
    const row = { discord_id: '1', status: 'pending', requested_at: new Date(), approved_at: null, approved_by: null, user_name: 'Alice', approver_name: null };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await getPendingRequests();
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('pending');
    expect(result[0].user_name).toBe('Alice');
  });
});

// ─── getAllApiKeys ────────────────────────────────────────────────────────────

describe('getAllApiKeys', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const result = await getAllApiKeys();
    expect(result).toEqual([]);
  });

  it('maps multiple rows with different statuses', async () => {
    const rows = [
      { discord_id: '1', status: 'approved', requested_at: new Date(), approved_at: new Date(), approved_by: '2', user_name: 'Alice', approver_name: 'Admin' },
      { discord_id: '3', status: 'revoked', requested_at: new Date(), approved_at: null, approved_by: null, user_name: 'Bob', approver_name: null },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getAllApiKeys();
    expect(result).toHaveLength(2);
    expect(result[0].status).toBe('approved');
    expect(result[1].status).toBe('revoked');
  });
});

// ─── requestApiKey ────────────────────────────────────────────────────────────

describe('requestApiKey', () => {
  it('throws when existing status is denied', async () => {
    const row = { discord_id: '1', status: 'denied', requested_at: new Date(), approved_at: null, approved_by: null, user_name: null, approver_name: null };
    const pool = makePool([row]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(requestApiKey('1', 0)).rejects.toThrow('denied');
  });

  it('returns status=approved for MANAGER access level (2)', async () => {
    // First call returns null (no existing row), second returns approved row
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[]])    // getApiKeyStatus initial
        .mockResolvedValueOnce([[]])    // INSERT
        .mockResolvedValueOnce([[{     // getApiKeyStatus after insert
          discord_id: '1', status: 'approved', requested_at: new Date(), approved_at: new Date(), approved_by: '1', user_name: null, approver_name: null,
        }]]),
    };
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await requestApiKey('1', 2);
    expect(result.status).toBe('approved');
    expect(result.plain).toHaveLength(64); // 32 bytes as hex
  });

  it('returns status=pending for USER access level (0)', async () => {
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[]])   // getApiKeyStatus initial
        .mockResolvedValueOnce([[]])   // INSERT
        .mockResolvedValueOnce([[{    // getApiKeyStatus after insert
          discord_id: '1', status: 'pending', requested_at: new Date(), approved_at: null, approved_by: null, user_name: null, approver_name: null,
        }]]),
    };
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await requestApiKey('1', 0);
    expect(result.status).toBe('pending');
  });

  it('generates a 64-character hex plain key', async () => {
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{
          discord_id: '1', status: 'pending', requested_at: new Date(), approved_at: null, approved_by: null, user_name: null, approver_name: null,
        }]]),
    };
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await requestApiKey('1', 1);
    expect(result.plain).toMatch(/^[0-9a-f]{64}$/);
  });
});
