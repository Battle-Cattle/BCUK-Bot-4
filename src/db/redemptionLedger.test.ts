import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import { getRedemptionProgress, markRedemptionEffect, pruneRedemptionLedger, isRedemptionLedgerReady } from './redemptionLedger';
import { makeMockPool } from '../test-utils/mockMysqlPool';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getRedemptionProgress', () => {
  it('returns null when nothing is recorded for the redemption', async () => {
    const pool = makeMockPool({ rows: [] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(getRedemptionProgress('r1')).resolves.toBeNull();
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM redemption_handled WHERE redemption_id = ?');
    expect(params).toEqual(['r1']);
  });

  it('maps a partially-handled row', async () => {
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows: [{ dashboard_recorded: 1, pricing_applied: 0, handled_at: null }] }) as any);
    await expect(getRedemptionProgress('r1')).resolves.toEqual({ dashboardRecorded: true, pricingApplied: false, handled: false });
  });

  it('maps a fully-handled row', async () => {
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows: [{ dashboard_recorded: 1, pricing_applied: 1, handled_at: new Date() }] }) as any);
    await expect(getRedemptionProgress('r1')).resolves.toEqual({ dashboardRecorded: true, pricingApplied: true, handled: true });
  });
});

describe('markRedemptionEffect', () => {
  it.each([
    ['dashboard_recorded', 'dashboard_recorded', '1'],
    ['pricing_applied', 'pricing_applied', '1'],
    ['handled', 'handled_at', 'NOW()'],
  ] as const)('upserts %s with the row-alias form', async (effect, column, value) => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await markRedemptionEffect('r1', 5, effect);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain(`INSERT INTO redemption_handled (redemption_id, streamer_id, ${column}) VALUES (?, ?, ${value}) AS new_row`);
    expect(sql).toContain(`ON DUPLICATE KEY UPDATE ${column} = new_row.${column}`);
    expect(params).toEqual(['r1', 5]);
  });
});

describe('markRedemptionEffect executor', () => {
  it('writes through the given transaction connection instead of the pool', async () => {
    const pool = makeMockPool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    const conn = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };

    await markRedemptionEffect('r1', 5, 'pricing_applied', conn as any);

    expect(conn.execute).toHaveBeenCalledOnce();
    expect(pool.execute).not.toHaveBeenCalled();
  });
});

describe('isRedemptionLedgerReady', () => {
  it('returns true when the table can be queried', async () => {
    const pool = makeMockPool({ rows: [] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(isRedemptionLedgerReady()).resolves.toBe(true);
    expect(pool.execute.mock.calls[0][0]).toBe('SELECT 1 FROM redemption_handled LIMIT 1');
  });

  it('returns false when the table does not exist (migration not applied)', async () => {
    const pool = makeMockPool();
    pool.execute.mockRejectedValueOnce(Object.assign(new Error("Table 'bcuk.redemption_handled' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' }));
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(isRedemptionLedgerReady()).resolves.toBe(false);
  });

  it('rethrows any other query error', async () => {
    const pool = makeMockPool();
    pool.execute.mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' }));
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(isRedemptionLedgerReady()).rejects.toThrow('connection lost');
  });
});

describe('pruneRedemptionLedger', () => {
  it('deletes rows older than the retention, in whole seconds, and returns the count', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 3 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(pruneRedemptionLedger(6 * 60 * 60 * 1000 + 1)).resolves.toBe(3);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('DELETE FROM redemption_handled WHERE created_at < (NOW() - INTERVAL ? SECOND)');
    expect(params).toEqual([6 * 60 * 60 + 1]);
  });
});
