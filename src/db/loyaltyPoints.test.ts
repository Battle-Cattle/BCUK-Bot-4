import { describe, it, expect, vi, beforeEach } from 'vitest';

// `withTransaction` is reimplemented here (rather than via `importOriginal`) so this test
// doesn't pull in pool.ts's real `../shared/config` import chain, which throws in a test
// environment with no DISCORD_TOKEN etc. set. Mirrors counters.test.ts's identical setup.
vi.mock('./pool', () => {
  const getPool = vi.fn();
  return {
    getPool,
    withTransaction: async (work: (conn: unknown) => Promise<unknown>) => {
      const conn = await getPool().getConnection();
      try {
        await conn.beginTransaction();
        const result = await work(conn);
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
  };
});
vi.mock('mysql2/promise', () => ({ default: {} }));

import { makeMockPool } from '../test-utils/mockMysqlPool';
import { getPool } from './pool';
import { getBalance, getLeaderboard, getConfig, adjustBalance, resolveGambleOutcome, setConfig, getAllConfigs } from './loyaltyPoints';

/** Builds a fake pool via the shared helper, matching this file's `(rows, meta)` call shape. */
function makePool(rows: unknown[] = [], meta: unknown = {}) {
  return makeMockPool({ rows, meta });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getBalance ───────────────────────────────────────────────────────────────

describe('getBalance', () => {
  it('returns 0 when the viewer has no row', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getBalance(1, 'viewer')).toBe(0);
  });

  it('returns the row\'s balance when one exists', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ balance: 42 }]) as any);
    expect(await getBalance(1, 'viewer')).toBe(42);
  });
});

// ─── getLeaderboard ───────────────────────────────────────────────────────────

describe('getLeaderboard', () => {
  it('maps rows to leaderboard entries, highest balance first', async () => {
    const pool = makePool([{ twitch_username: 'top', balance: 500 }, { twitch_username: 'second', balance: 100 }]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await getLeaderboard(1, 50)).toEqual([
      { twitchUsername: 'top', balance: 500 },
      { twitchUsername: 'second', balance: 100 },
    ]);
  });

  it('returns an empty array for a streamer with no balances', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getLeaderboard(1, 50)).toEqual([]);
  });

  it('passes the limit through to the query', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getLeaderboard(1, 10);
    expect(pool.execute).toHaveBeenCalledWith(expect.stringContaining('LIMIT'), [1, 10]);
  });
});

// ─── getConfig ────────────────────────────────────────────────────────────────

describe('getConfig', () => {
  it('returns null when the streamer has no config row', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getConfig(1)).toBeNull();
  });

  it('maps an existing row to a LoyaltyPointsConfig', async () => {
    const pool = makePool([{ enabled: 1, points_per_message: 2, cooldown_seconds: 30, points_per_sub: 100, points_per_gift_sub: 100 }]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await getConfig(1)).toEqual({
      enabled: true,
      pointsPerMessage: 2,
      cooldownSeconds: 30,
      pointsPerSub: 100,
      pointsPerGiftSub: 100,
    });
  });

  it('maps enabled = 0 to false', async () => {
    const pool = makePool([{ enabled: 0, points_per_message: 1, cooldown_seconds: 60, points_per_sub: 100, points_per_gift_sub: 100 }]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await getConfig(1)).toEqual(expect.objectContaining({ enabled: false }));
  });
});

// ─── adjustBalance ────────────────────────────────────────────────────────────

describe('adjustBalance', () => {
  it('inserts a new row and returns the clamped starting balance', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])          // INSERT ... ON DUPLICATE KEY UPDATE
      .mockResolvedValueOnce([[{ balance: 5 }], []]);             // SELECT LAST_INSERT_ID()
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await adjustBalance(1, 'viewer', 5)).toBe(5);
    expect(conn.commit).toHaveBeenCalled();
  });

  it('adds delta to an existing balance', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 2 }, []])
      .mockResolvedValueOnce([[{ balance: 15 }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await adjustBalance(1, 'viewer', 5)).toBe(15);
  });

  it('clamps the result at 0 on over-decrement', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 2 }, []])
      .mockResolvedValueOnce([[{ balance: 0 }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await adjustBalance(1, 'viewer', -100)).toBe(0);
  });

  it('clamps the result at the INT column maximum on over-increment', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 2 }, []])
      .mockResolvedValueOnce([[{ balance: 2147483647 }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await adjustBalance(1, 'viewer', 4_000_000_000)).toBe(2147483647);
    expect(conn.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('LEAST'),
      [1, 'viewer', 4_000_000_000, 2147483647, 4_000_000_000, 2147483647],
    );
  });

  it('parses a string balance into a number (LAST_INSERT_ID() is a BIGINT expression)', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([[{ balance: '7' }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await adjustBalance(1, 'viewer', 7)).toBe(7);
  });

  it('rolls back and rethrows on failure', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute.mockRejectedValueOnce(new Error('db exploded'));
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(adjustBalance(1, 'viewer', 5)).rejects.toThrow('db exploded');
    expect(conn.rollback).toHaveBeenCalled();
  });
});

// ─── resolveGambleOutcome ───────────────────────────────────────────────────────

describe('resolveGambleOutcome', () => {
  it('debits the stake and credits double back on a win, in one transaction', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])   // debit
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])   // credit (2 * bet)
      .mockResolvedValueOnce([[{ balance: 1100 }], []]);  // SELECT LAST_INSERT_ID()
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await resolveGambleOutcome(1, 'viewer', 100, true)).toBe(1100);
    expect(conn.execute).toHaveBeenCalledTimes(3);
    expect(conn.commit).toHaveBeenCalled();
  });

  it('clamps a winning credit at the INT column maximum rather than overflowing it', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([[{ balance: 2147483647 }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await resolveGambleOutcome(1, 'viewer', 2_000_000_000, true)).toBe(2147483647);
    expect(conn.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('LEAST'),
      [4_000_000_000, 2147483647, 1, 'viewer'],
    );
  });

  it('debits the stake and makes no credit write on a loss', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])   // debit
      .mockResolvedValueOnce([[{ balance: 900 }], []]);   // SELECT LAST_INSERT_ID()
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await resolveGambleOutcome(1, 'viewer', 100, false)).toBe(900);
    expect(conn.execute).toHaveBeenCalledTimes(2);
  });

  it('returns null when the balance is insufficient, without any credit write', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute.mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await resolveGambleOutcome(1, 'viewer', 100, true)).toBeNull();
    expect(conn.execute).toHaveBeenCalledTimes(1);
  });

  it('returns null for a viewer with no row at all', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute.mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await resolveGambleOutcome(1, 'new-viewer', 1, false)).toBeNull();
  });

  it('parses a string balance into a number (LAST_INSERT_ID() is a BIGINT expression)', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([[{ balance: '900' }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await resolveGambleOutcome(1, 'viewer', 100, false)).toBe(900);
  });

  it('rolls back and rethrows on failure', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute.mockRejectedValueOnce(new Error('db exploded'));
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(resolveGambleOutcome(1, 'viewer', 100, false)).rejects.toThrow('db exploded');
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('rolls back the already-applied debit if the winning credit fails', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])      // debit succeeds
      .mockRejectedValueOnce(new Error('credit db exploded')); // credit fails
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(resolveGambleOutcome(1, 'viewer', 100, true)).rejects.toThrow('credit db exploded');
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });
});

// ─── setConfig ────────────────────────────────────────────────────────────────

describe('setConfig', () => {
  it('upserts the streamer\'s configuration, including the opt-in flag', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    const config = { enabled: true, pointsPerMessage: 2, cooldownSeconds: 30, pointsPerSub: 150, pointsPerGiftSub: 150 };

    await setConfig(1, config);

    expect(pool.execute).toHaveBeenCalledWith(expect.stringContaining('ON DUPLICATE KEY UPDATE'), [1, true, 2, 30, 150, 150]);
  });
});

// ─── getAllConfigs ────────────────────────────────────────────────────────────

describe('getAllConfigs', () => {
  it('returns an empty array when no streamer has configured points', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getAllConfigs()).toEqual([]);
  });

  it('maps every row to its streamer id and config', async () => {
    const pool = makePool([
      { streamer_id: 1, enabled: 1, points_per_message: 1, cooldown_seconds: 60, points_per_sub: 100, points_per_gift_sub: 100 },
      { streamer_id: 2, enabled: 0, points_per_message: 3, cooldown_seconds: 15, points_per_sub: 50, points_per_gift_sub: 50 },
    ]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await getAllConfigs()).toEqual([
      { streamerId: 1, config: { enabled: true, pointsPerMessage: 1, cooldownSeconds: 60, pointsPerSub: 100, pointsPerGiftSub: 100 } },
      { streamerId: 2, config: { enabled: false, pointsPerMessage: 3, cooldownSeconds: 15, pointsPerSub: 50, pointsPerGiftSub: 50 } },
    ]);
  });
});
