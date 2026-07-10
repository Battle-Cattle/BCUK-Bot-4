import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));
vi.mock('./users', () => ({
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
}));

import { getPool } from './pool';
import { AccessLevel } from './users';
import {
  hasApiKey,
  createApiKeyAndRequestGuildAccess,
  requestGuildAccessForExistingKey,
  rotateApiKey,
  findApprovedKeyByHash,
  isKeyApprovedForGuild,
  getApprovedGuildIdsForKey,
  getGuildStatusForKey,
  approveApiKey,
  denyApiKey,
  revokeApiKey,
  getPendingRequests,
  getAllApiKeys,
} from './streamdeckKeys';
import { createHash } from 'crypto';

function makePool(rows: unknown[] = []) {
  return { execute: vi.fn().mockResolvedValue([[...rows], []]) };
}

/** Pool mock whose getConnection() returns a fake transactional connection, matching the overlayVideos.ts test convention. */
function makeTransactionalPool() {
  const conn = {
    execute: vi.fn().mockResolvedValue([[], []]),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  return {
    execute: vi.fn().mockResolvedValue([[], []]),
    getConnection: vi.fn().mockResolvedValue(conn),
    _conn: conn,
  };
}

function sha256hex(s: string) {
  return createHash('sha256').update(s).digest('hex');
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── hasApiKey ────────────────────────────────────────────────────────────────

describe('hasApiKey', () => {
  it('returns false when no rows found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await hasApiKey('1')).toBe(false);
  });

  it('returns true when a row exists', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ 1: 1 }]) as any);
    expect(await hasApiKey('1')).toBe(true);
  });
});

// ─── createApiKeyAndRequestGuildAccess ─────────────────────────────────────────

describe('createApiKeyAndRequestGuildAccess', () => {
  it('inserts an identity row and a guild-status row within one transaction, returning a 64-char hex plain key', async () => {
    const pool = makeTransactionalPool();
    vi.mocked(getPool).mockReturnValue(pool as any);

    const result = await createApiKeyAndRequestGuildAccess('1', AccessLevel.USER, 'g1');

    expect(result.plain).toMatch(/^[0-9a-f]{64}$/);
    expect(result.status).toBe('pending');
    expect(pool._conn.beginTransaction).toHaveBeenCalledOnce();
    expect(pool._conn.execute).toHaveBeenCalledTimes(2);
    const [identitySql, identityParams] = pool._conn.execute.mock.calls[0] as [string, unknown[]];
    expect(identitySql).toContain('INSERT INTO streamdeck_api_keys');
    expect(identityParams[0]).toBe('1');
    const [statusSql, statusParams] = pool._conn.execute.mock.calls[1] as [string, unknown[]];
    expect(statusSql).toContain('INSERT INTO streamdeck_key_guild_status');
    expect(statusParams).toEqual(['1', 'g1', 'pending', expect.any(Date), null, null]);
    expect(pool._conn.commit).toHaveBeenCalledOnce();
    expect(pool._conn.rollback).not.toHaveBeenCalled();
    expect(pool._conn.release).toHaveBeenCalledOnce();
  });

  it('auto-approves for MANAGER access level and above', async () => {
    const pool = makeTransactionalPool();
    vi.mocked(getPool).mockReturnValue(pool as any);

    const result = await createApiKeyAndRequestGuildAccess('1', AccessLevel.MANAGER, 'g1');

    expect(result.status).toBe('approved');
    const [, statusParams] = pool._conn.execute.mock.calls[1] as [string, unknown[]];
    expect(statusParams).toEqual(['1', 'g1', 'approved', expect.any(Date), expect.any(Date), '1']);
  });

  it('rolls back and releases the connection, without returning a result, when the second insert fails', async () => {
    const pool = makeTransactionalPool();
    pool._conn.execute
      .mockResolvedValueOnce([[], []]) // identity insert succeeds
      .mockRejectedValueOnce(new Error('duplicate guild-status row')); // guild-status insert fails
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(createApiKeyAndRequestGuildAccess('1', AccessLevel.USER, 'g1')).rejects.toThrow('duplicate guild-status row');

    expect(pool._conn.commit).not.toHaveBeenCalled();
    expect(pool._conn.rollback).toHaveBeenCalledOnce();
    expect(pool._conn.release).toHaveBeenCalledOnce();
  });
});

// ─── requestGuildAccessForExistingKey ──────────────────────────────────────────

describe('requestGuildAccessForExistingKey', () => {
  it('upserts a guild-status row and returns pending for below-Manager access', async () => {
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[]]) // upsert
        .mockResolvedValueOnce([[{ discord_id: '1', guild_id: 'g2', status: 'pending', requested_at: new Date(), approved_at: null, approved_by: null }]]),
    };
    vi.mocked(getPool).mockReturnValue(pool as any);

    const result = await requestGuildAccessForExistingKey('1', AccessLevel.USER, 'g2');

    expect(result.status).toBe('pending');
    const [sql] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
  });

  it('throws when the resulting status is denied (a previous request for this guild was denied)', async () => {
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[]]) // upsert (no-ops, guarded by the denied check)
        .mockResolvedValueOnce([[{ discord_id: '1', guild_id: 'g2', status: 'denied', requested_at: new Date(), approved_at: null, approved_by: null }]]),
    };
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(requestGuildAccessForExistingKey('1', AccessLevel.USER, 'g2')).rejects.toThrow('denied');
  });

  it('qualifies every bare column reference in the upsert IF() conditions to avoid ambiguity with new_row', async () => {
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{ discord_id: '1', guild_id: 'g2', status: 'pending', requested_at: new Date(), approved_at: null, approved_by: null }]]),
    };
    vi.mocked(getPool).mockReturnValue(pool as any);

    await requestGuildAccessForExistingKey('1', AccessLevel.USER, 'g2');
    const [sql] = pool.execute.mock.calls[0] as [string, unknown[]];
    const updateClause = sql.slice(sql.indexOf('ON DUPLICATE KEY UPDATE'));
    for (const match of updateClause.matchAll(/IF\(([^,]+),/g)) {
      expect(match[1]).toContain('streamdeck_key_guild_status.');
    }
  });
});

// ─── rotateApiKey ───────────────────────────────────────────────────────────────

describe('rotateApiKey', () => {
  it('updates key_hash and created_at for the given discordId, returning a new plain key', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);

    const result = await rotateApiKey('1');

    expect(result.plain).toMatch(/^[0-9a-f]{64}$/);
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE streamdeck_api_keys');
    expect(sql).toContain('key_hash = ?');
    expect(params[2]).toBe('1');
  });
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
    const row = { discord_id: '1', key_hash: stored };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await findApprovedKeyByHash(incoming);
    expect(result).toBeNull();
  });

  it('returns the owning discordId when hash matches', async () => {
    const hash = sha256hex('mysecretkey');
    const row = { discord_id: '42', key_hash: hash };
    const pool = makePool([row]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await findApprovedKeyByHash(hash);
    expect(result).toEqual({ discordId: '42' });
    const [sql] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'approved'");
  });

  it('returns null when stored and incoming hash have different lengths', async () => {
    const incoming = 'ab'.repeat(32); // 64 chars
    const stored = 'ab'.repeat(16);   // 32 chars — different length
    const row = { discord_id: '1', key_hash: stored };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await findApprovedKeyByHash(incoming);
    expect(result).toBeNull();
  });
});

// ─── isKeyApprovedForGuild ──────────────────────────────────────────────────────

describe('isKeyApprovedForGuild', () => {
  it('returns true when a matching approved row exists', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ 1: 1 }]) as any);
    expect(await isKeyApprovedForGuild('1', 'g1')).toBe(true);
  });

  it('returns false when no matching approved row exists', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await isKeyApprovedForGuild('1', 'g1')).toBe(false);
  });
});

// ─── getApprovedGuildIdsForKey ─────────────────────────────────────────────────

describe('getApprovedGuildIdsForKey', () => {
  it('returns the list of approved guild IDs as strings', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ guild_id: 'g1' }, { guild_id: 'g2' }]) as any);
    expect(await getApprovedGuildIdsForKey('1')).toEqual(['g1', 'g2']);
  });

  it('returns an empty array when no approved guilds', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getApprovedGuildIdsForKey('1')).toEqual([]);
  });
});

// ─── getGuildStatusForKey ───────────────────────────────────────────────────────

describe('getGuildStatusForKey', () => {
  it('returns null when no rows found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const result = await getGuildStatusForKey('999', 'g1');
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
    };
    const pool = makePool([row]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getGuildStatusForKey('123', 'g1');
    expect(result!.discord_id).toBe('123');
    expect(result!.guild_id).toBe('g1');
    expect(result!.status).toBe('pending');
    expect(result!.requested_at).toBe(now);
    expect(result!.approved_at).toBeNull();
    expect(result!.approved_by).toBeNull();
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('guild_id = ?');
    expect(params).toEqual(['123', 'g1']);
  });

  it('maps a row with approver info', async () => {
    const row = {
      discord_id: '1',
      guild_id: 'g1',
      status: 'approved',
      requested_at: new Date(),
      approved_at: new Date(),
      approved_by: '99',
    };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await getGuildStatusForKey('1', 'g1');
    expect(result!.approved_by).toBe('99');
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
  it('executes UPDATE setting status to revoked, scoped to guildId', async () => {
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
    expect(sql).toContain('s.guild_id = ?');
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
    expect(sql).toContain('s.guild_id = ?');
    expect(params).toEqual(['g1']);
  });
});
