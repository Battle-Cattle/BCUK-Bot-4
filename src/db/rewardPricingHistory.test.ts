import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import { recordPricingHistory, getPricingHistory, getPricingHistoryForRewards } from './rewardPricingHistory';
import { makeMockPool } from '../test-utils/mockMysqlPool';

/** Builds a fake mysql pool whose `execute`/`query` resolve to the given rows/meta. */
function makePool(rows: unknown[] = [], meta: unknown = {}) {
  return makeMockPool({ rows, meta });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordPricingHistory', () => {
  it('inserts the point and prunes points older than the retention window', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);

    await recordPricingHistory(5, 350, 0.42, 1_700_100_000_000);

    expect(pool.execute).toHaveBeenCalledTimes(2);
    const [insertSql, insertParams] = pool.execute.mock.calls[0];
    expect(insertSql).toContain('INSERT INTO reward_pricing_history');
    expect(insertParams).toEqual([5, 1_700_100_000_000, 350, 0.42]);

    const [deleteSql, deleteParams] = pool.execute.mock.calls[1];
    expect(deleteSql).toContain('DELETE FROM reward_pricing_history');
    expect(deleteParams[0]).toBe(5);
    expect(deleteParams[1]).toBe(1_700_100_000_000 - 25 * 60 * 60 * 1000);
  });
});

describe('getPricingHistory', () => {
  it('returns an empty array when no points are found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getPricingHistory(5, 1_700_000_000_000)).toEqual([]);
  });

  it('maps rows, converting recorded_at to a string and demand to a number', async () => {
    const rows = [{ recorded_at: '1700100000000', cost: 350, demand: '0.420000' }];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const points = await getPricingHistory(5, 1_700_000_000_000);
    expect(points).toEqual([{ recorded_at: '1700100000000', cost: 350, demand: 0.42 }]);
  });

  it('queries with rewardPricingId and sinceMs, ordered ascending', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getPricingHistory(5, 1_700_000_000_000);
    expect(pool.execute.mock.calls[0][1]).toEqual([5, 1_700_000_000_000]);
    expect(pool.execute.mock.calls[0][0]).toContain('ORDER BY recorded_at ASC');
  });
});

describe('getPricingHistoryForRewards', () => {
  it('returns an empty map without querying when given an empty array', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await getPricingHistoryForRewards([], 1_700_000_000_000);
    expect(result.size).toBe(0);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('groups points by reward_pricing_id', async () => {
    const rows = [
      { reward_pricing_id: 5, recorded_at: '1700100000000', cost: 350, demand: '0.42' },
      { reward_pricing_id: 5, recorded_at: '1700200000000', cost: 400, demand: '0.55' },
      { reward_pricing_id: 9, recorded_at: '1700100000000', cost: 100, demand: '0.10' },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);

    const result = await getPricingHistoryForRewards([5, 9], 1_700_000_000_000);

    expect(result.size).toBe(2);
    expect(result.get(5)).toEqual([
      { recorded_at: '1700100000000', cost: 350, demand: 0.42 },
      { recorded_at: '1700200000000', cost: 400, demand: 0.55 },
    ]);
    expect(result.get(9)).toEqual([{ recorded_at: '1700100000000', cost: 100, demand: 0.1 }]);
  });

  it('omits reward ids with no points rather than including an empty array', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const result = await getPricingHistoryForRewards([5], 1_700_000_000_000);
    expect(result.has(5)).toBe(false);
  });

  it('builds an IN clause with one placeholder per id, plus sinceMs', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getPricingHistoryForRewards([5, 9, 12], 1_700_000_000_000);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('reward_pricing_id IN (?, ?, ?)');
    expect(params).toEqual([5, 9, 12, 1_700_000_000_000]);
  });
});
