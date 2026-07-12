import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import {
  getPricingForReward,
  getPricingConfigById,
  getPricingConfigsForStreamer,
  getAllEnabledPricingRows,
  upsertPricingConfig,
  recordPricingUpdate,
  deletePricingConfig,
  markPricingUnsupported,
  updatePricingCooldownForReward,
  getPricingSettingsForStreamer,
  savePricingSettingsForStreamer,
} from './rewardPricing';
import { makeMockPool } from '../test-utils/mockMysqlPool';

function makePool(rows: unknown[] = [], meta: unknown = {}) {
  return makeMockPool({ rows, meta });
}

beforeEach(() => {
  vi.clearAllMocks();
});

const sampleRow = {
  id: 1,
  streamer_id: 7,
  twitch_reward_id: 'rwd-abc',
  enabled: 1,
  base_cost: 200,
  cooldown_seconds: 300,
  max_multiplier: '4.000',
  curve: '1.500',
  round_to_nearest: 0,
  demand: '0.500000',
  demand_updated_at: '1700000000000',
  last_pushed_cost: 400,
  twitch_unsupported: 0,
};

describe('getPricingForReward', () => {
  it('returns null when no row found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getPricingForReward(7, 'rwd-abc')).toBeNull();
  });

  it('maps a found row, converting numeric strings and BIT columns', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([sampleRow]) as any);
    const row = await getPricingForReward(7, 'rwd-abc');
    expect(row).toEqual({
      id: 1,
      streamer_id: 7,
      twitch_reward_id: 'rwd-abc',
      enabled: true,
      base_cost: 200,
      cooldown_seconds: 300,
      max_multiplier: 4,
      curve: 1.5,
      round_to_nearest: 0,
      demand: 0.5,
      demand_updated_at: '1700000000000',
      last_pushed_cost: 400,
      twitch_unsupported: false,
    });
  });

  it('queries with streamerId and twitchRewardId', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getPricingForReward(7, 'rwd-abc');
    expect(pool.execute.mock.calls[0][1]).toEqual([7, 'rwd-abc']);
  });

  it('maps a null last_pushed_cost as null', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ ...sampleRow, last_pushed_cost: null }]) as any);
    const row = await getPricingForReward(7, 'rwd-abc');
    expect(row!.last_pushed_cost).toBeNull();
  });
});

describe('getPricingConfigById', () => {
  it('returns null when no row found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getPricingConfigById(1, 7)).toBeNull();
  });

  it('returns the mapped row when found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([sampleRow]) as any);
    const row = await getPricingConfigById(1, 7);
    expect(row!.id).toBe(1);
    expect(row!.twitch_reward_id).toBe('rwd-abc');
  });

  it('queries with id and streamerId', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getPricingConfigById(1, 7);
    expect(pool.execute.mock.calls[0][1]).toEqual([1, 7]);
  });
});

describe('getPricingConfigsForStreamer', () => {
  it('returns all rows for the streamer', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([sampleRow, { ...sampleRow, id: 2 }]) as any);
    const rows = await getPricingConfigsForStreamer(7);
    expect(rows).toHaveLength(2);
  });
});

describe('getAllEnabledPricingRows', () => {
  it('returns all enabled rows without params', async () => {
    const pool = makePool([sampleRow]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const rows = await getAllEnabledPricingRows();
    expect(rows).toHaveLength(1);
    expect(pool.execute.mock.calls[0][0]).toContain('enabled = 1');
  });
});

describe('upsertPricingConfig', () => {
  it('uses the row-alias ON DUPLICATE KEY UPDATE form', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await upsertPricingConfig(7, 'rwd-abc', { enabled: true, base_cost: 200, cooldown_seconds: 300, max_multiplier: 4, curve: 1.5, round_to_nearest: 0 });
    const sql: string = pool.execute.mock.calls[0][0];
    expect(sql).toContain('AS new_row');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
  });

  it('does not touch demand, demand_updated_at, or last_pushed_cost in the SET list', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await upsertPricingConfig(7, 'rwd-abc', { enabled: true, base_cost: 200, cooldown_seconds: 300, max_multiplier: 4, curve: 1.5, round_to_nearest: 0 });
    const sql: string = pool.execute.mock.calls[0][0];
    const setClause = sql.split('ON DUPLICATE KEY UPDATE')[1];
    expect(setClause).not.toContain('demand=');
    expect(setClause).not.toContain('demand_updated_at=');
    expect(setClause).not.toContain('last_pushed_cost=');
  });

  it('clears twitch_unsupported in the SET list, so an explicit save gives the reward another attempt', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await upsertPricingConfig(7, 'rwd-abc', { enabled: true, base_cost: 200, cooldown_seconds: 300, max_multiplier: 4, curve: 1.5, round_to_nearest: 0 });
    const sql: string = pool.execute.mock.calls[0][0];
    const setClause = sql.split('ON DUPLICATE KEY UPDATE')[1];
    expect(setClause).toContain('twitch_unsupported=0');
  });

  it('includes round_to_nearest in both the column list and the SET list', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await upsertPricingConfig(7, 'rwd-abc', { enabled: true, base_cost: 200, cooldown_seconds: 300, max_multiplier: 4, curve: 1.5, round_to_nearest: 5 });
    const sql: string = pool.execute.mock.calls[0][0];
    expect(sql).toContain('round_to_nearest');
    const setClause = sql.split('ON DUPLICATE KEY UPDATE')[1];
    expect(setClause).toContain('round_to_nearest=new_row.round_to_nearest');
  });

  it('passes converted enabled boolean and config fields', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await upsertPricingConfig(7, 'rwd-abc', { enabled: false, base_cost: 100, cooldown_seconds: 60, max_multiplier: 2, curve: 1, round_to_nearest: 10 });
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params[0]).toBe(7);
    expect(params[1]).toBe('rwd-abc');
    expect(params[2]).toBe(0);
    expect(params[3]).toBe(100);
    expect(params[4]).toBe(60);
    expect(params[5]).toBe(2);
    expect(params[6]).toBe(1);
    expect(params[7]).toBe(10);
  });
});

describe('recordPricingUpdate', () => {
  it('updates exactly demand, demand_updated_at, and last_pushed_cost', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await recordPricingUpdate(7, 'rwd-abc', 0.75, 1700000000000, 350);
    const sql: string = pool.execute.mock.calls[0][0];
    expect(sql).toContain('SET demand = ?, demand_updated_at = ?, last_pushed_cost = ?');
    expect(pool.execute.mock.calls[0][1]).toEqual([0.75, 1700000000000, 350, 7, 'rwd-abc']);
  });

  it('accepts a null lastPushedCost', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await recordPricingUpdate(7, 'rwd-abc', 0.1, 1700000000000, null);
    expect(pool.execute.mock.calls[0][1]).toEqual([0.1, 1700000000000, null, 7, 'rwd-abc']);
  });
});

describe('markPricingUnsupported', () => {
  it('disables the row and sets twitch_unsupported, scoped by streamerId and twitchRewardId', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await markPricingUnsupported(7, 'rwd-abc');
    const sql: string = pool.execute.mock.calls[0][0];
    expect(sql).toContain('SET enabled = 0, twitch_unsupported = 1');
    expect(pool.execute.mock.calls[0][1]).toEqual([7, 'rwd-abc']);
  });
});

describe('deletePricingConfig', () => {
  it('scopes the DELETE by both id and streamerId', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await deletePricingConfig(3, 7);
    expect(pool.execute.mock.calls[0][1]).toEqual([3, 7]);
  });
});

describe('updatePricingCooldownForReward', () => {
  it('updates cooldown_seconds, scoped by streamerId and twitchRewardId', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await updatePricingCooldownForReward(7, 'rwd-abc', 120);
    const sql: string = pool.execute.mock.calls[0][0];
    expect(sql).toContain('SET cooldown_seconds = ?');
    expect(pool.execute.mock.calls[0][1]).toEqual([120, 7, 'rwd-abc']);
  });
});

describe('getPricingSettingsForStreamer', () => {
  it('returns defaults without throwing when the row is missing', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const settings = await getPricingSettingsForStreamer(7);
    expect(settings).toEqual({ half_life_seconds: 1800, time_to_max_multiplier: 2 });
  });

  it('returns the stored row converted to numbers', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ half_life_seconds: '900', time_to_max_multiplier: '3.000' }]) as any);
    const settings = await getPricingSettingsForStreamer(7);
    expect(settings).toEqual({ half_life_seconds: 900, time_to_max_multiplier: 3 });
  });

  it('queries scoped by streamerId', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getPricingSettingsForStreamer(7);
    expect(pool.execute.mock.calls[0][1]).toEqual([7]);
  });
});

describe('savePricingSettingsForStreamer', () => {
  it('uses the row-alias upsert form and passes the streamerId and new settings', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await savePricingSettingsForStreamer(7, { half_life_seconds: 600, time_to_max_multiplier: 1.5 });
    const sql: string = pool.execute.mock.calls[0][0];
    expect(sql).toContain('AS new_row');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(pool.execute.mock.calls[0][1]).toEqual([7, 600, 1.5]);
  });
});
