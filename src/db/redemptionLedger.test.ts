import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import { getRedemptionProgress, markRedemptionEffect, pruneRedemptionLedger } from './redemptionLedger';
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
