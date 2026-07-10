import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));
vi.mock('./users', () => ({
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
}));

import { getPool } from './pool';
import { AccessLevel } from './users';
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
    const row = { discord_id: '42', key_hash: hash, guild_id: 'g1', status: 'approved', requested_at: new Date(), approved_at: new Date(), approved_by: '1' };
    const pool = makePool([row]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await findApprovedKeyByHash(hash);
    expect(result).not.toBeNull();
    expect(result!.discord_id).toBe('42');
    expect(result!.guild_id).toBe('g1');
    expect(result!.status).toBe('approved');
    const [sql] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('guild_id');
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
      guild_id: 'g1',
      status: 'pending',
      requested_at: now,
      approved_at: null,
      approved_by: null,
      user_name: null,
      approver_name: null,
    };
    const pool = makePool([row]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getApiKeyStatus('123');
    expect(result!.discord_id).toBe('123');
    expect(result!.guild_id).toBe('g1');
    expect(result!.status).toBe('pending');
    expect(result!.requested_at).toBe(now);
    expect(result!.approved_at).toBeNull();
    expect(result!.approved_by).toBeNull();
    const [sql] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('guild_id');
  });

  it('preserves a null guild_id instead of stringifying it', async () => {
    const row = {
      discord_id: '123',
      guild_id: null,
      status: 'pending',
      requested_at: new Date(),
      approved_at: null,
      approved_by: null,
      user_name: null,
      approver_name: null,
    };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await getApiKeyStatus('123');
    expect(result!.guild_id).toBeNull();
  });

  it('maps a row with approver info', async () => {
    const row = {
      discord_id: '1',
      guild_id: 'g1',
      status: 'approved',
      requested_at: new Date(),
      approved_at: new Date(),
      approved_by: '99',
      user_name: 'Alice',
      approver_name: 'Admin',
    };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await getApiKeyStatus('1');
    expect(result!.guild_id).toBe('g1');
    expect(result!.approved_by).toBe('99');
    expect(result!.user_name).toBe('Alice');
    expect(result!.approver_name).toBe('Admin');
  });
});

// ─── approveApiKey ────────────────────────────────────────────────────────────

describe('approveApiKey', () => {
  it('executes UPDATE with approvedBy, discordId, and guildId', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await approveApiKey('user1', 'admin1', 'g1');
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain('guild_id = ?');
    expect(params).toEqual(['admin1', 'user1', 'g1']);
  });
});

// ─── denyApiKey ───────────────────────────────────────────────────────────────

describe('denyApiKey', () => {
  it('executes UPDATE setting status to denied, scoped to guildId', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await denyApiKey('user1', 'g1');
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'denied'");
    expect(sql).toContain('guild_id = ?');
    expect(params).toEqual(['user1', 'g1']);
  });
});

// ─── revokeApiKey ─────────────────────────────────────────────────────────────

describe('revokeApiKey', () => {
  it('executes UPDATE setting status to revoked, with no guild scoping when guildId is omitted (self-service)', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await revokeApiKey('user1');
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'revoked'");
    expect(sql).not.toContain('guild_id');
    expect(params).toEqual(['user1']);
  });

  it('scopes the UPDATE to guildId when provided (admin-initiated revoke)', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await revokeApiKey('user1', 'g1');
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'revoked'");
    expect(sql).toContain('guild_id = ?');
    expect(params).toEqual(['user1', 'g1']);
  });
});

// ─── getPendingRequests ───────────────────────────────────────────────────────

describe('getPendingRequests', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const result = await getPendingRequests('g1');
    expect(result).toEqual([]);
  });

  it('maps pending rows and scopes the query to guildId', async () => {
    const row = { discord_id: '1', guild_id: 'g1', status: 'pending', requested_at: new Date(), approved_at: null, approved_by: null, user_name: 'Alice', approver_name: null };
    const pool = makePool([row]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getPendingRequests('g1');
    expect(result).toHaveLength(1);
    expect(result[0].guild_id).toBe('g1');
    expect(result[0].status).toBe('pending');
    expect(result[0].user_name).toBe('Alice');
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('k.guild_id = ?');
    expect(params).toEqual(['g1']);
  });
});

// ─── getAllApiKeys ────────────────────────────────────────────────────────────

describe('getAllApiKeys', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const result = await getAllApiKeys('g1');
    expect(result).toEqual([]);
  });

  it('maps multiple rows and scopes the query to guildId', async () => {
    const rows = [
      { discord_id: '1', guild_id: 'g1', status: 'approved', requested_at: new Date(), approved_at: new Date(), approved_by: '2', user_name: 'Alice', approver_name: 'Admin' },
      { discord_id: '3', guild_id: 'g1', status: 'revoked', requested_at: new Date(), approved_at: null, approved_by: null, user_name: 'Bob', approver_name: null },
    ];
    const pool = makePool(rows);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getAllApiKeys('g1');
    expect(result).toHaveLength(2);
    expect(result[0].guild_id).toBe('g1');
    expect(result[0].status).toBe('approved');
    expect(result[1].guild_id).toBe('g1');
    expect(result[1].status).toBe('revoked');
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('k.guild_id = ?');
    expect(params).toEqual(['g1']);
  });
});

// ─── requestApiKey ────────────────────────────────────────────────────────────

describe('requestApiKey', () => {
  it('throws when existing status is denied', async () => {
    const row = { discord_id: '1', guild_id: 'g1', status: 'denied', requested_at: new Date(), approved_at: null, approved_by: null, user_name: null, approver_name: null };
    const pool = makePool([row]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(requestApiKey('1', AccessLevel.USER, 'g1')).rejects.toThrow('denied');
  });

  it('returns status=approved for MANAGER access level (2)', async () => {
    // First call returns null (no existing row), second returns approved row
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[]])    // getApiKeyStatus initial
        .mockResolvedValueOnce([[]])    // INSERT
        .mockResolvedValueOnce([[{     // getApiKeyStatus after insert
          discord_id: '1', guild_id: 'g1', status: 'approved', requested_at: new Date(), approved_at: new Date(), approved_by: '1', user_name: null, approver_name: null,
        }]]),
    };
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await requestApiKey('1', AccessLevel.MANAGER, 'g1');
    expect(result.status).toBe('approved');
    expect(result.plain).toHaveLength(64); // 32 bytes as hex
    const [insertSql, insertParams] = pool.execute.mock.calls[1] as [string, unknown[]];
    expect(insertSql).toContain('(discord_id, key_hash, guild_id, status, requested_at, approved_at, approved_by)');
    expect(insertSql).toMatch(/guild_id\s*=\s*IF\(streamdeck_api_keys\.status = 'denied', streamdeck_api_keys\.guild_id,\s*new_row\.guild_id\)/);
    expect(insertParams[2]).toBe('g1');
  });

  it('returns status=pending for USER access level (0)', async () => {
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[]])   // getApiKeyStatus initial
        .mockResolvedValueOnce([[]])   // INSERT
        .mockResolvedValueOnce([[{    // getApiKeyStatus after insert
          discord_id: '1', guild_id: 'g1', status: 'pending', requested_at: new Date(), approved_at: null, approved_by: null, user_name: null, approver_name: null,
        }]]),
    };
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await requestApiKey('1', AccessLevel.USER, 'g1');
    expect(result.status).toBe('pending');
  });

  it('generates a 64-character hex plain key', async () => {
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{
          discord_id: '1', guild_id: 'g1', status: 'pending', requested_at: new Date(), approved_at: null, approved_by: null, user_name: null, approver_name: null,
        }]]),
    };
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await requestApiKey('1', AccessLevel.MOD, 'g1');
    expect(result.plain).toMatch(/^[0-9a-f]{64}$/);
  });

  it('qualifies every bare column reference in the upsert IF() conditions to avoid ambiguity with new_row', async () => {
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{
          discord_id: '1', guild_id: 'g1', status: 'pending', requested_at: new Date(), approved_at: null, approved_by: null, user_name: null, approver_name: null,
        }]]),
    };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await requestApiKey('1', AccessLevel.USER, 'g1');
    const [insertSql] = pool.execute.mock.calls[1] as [string, unknown[]];
    const updateClause = insertSql.slice(insertSql.indexOf('ON DUPLICATE KEY UPDATE'));
    // every "IF(" condition must reference the base table, not a bare column, to avoid
    // "Column 'status' in field list is ambiguous" against the new_row alias
    for (const match of updateClause.matchAll(/IF\(([^,]+),/g)) {
      expect(match[1]).toContain('streamdeck_api_keys.');
    }
  });
});
