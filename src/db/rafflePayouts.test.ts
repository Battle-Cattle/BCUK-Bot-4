import { describe, it, expect, vi, beforeEach } from 'vitest';

// `withTransaction` is reimplemented here so this test doesn't pull in pool.ts's real config
// import chain (mirrors loyaltyPoints.test.ts).
vi.mock('./pool', () => {
  const getPool = vi.fn();
  return {
    getPool,
    runInTransaction: async (conn: any, work: () => Promise<unknown>) => {
      await conn.beginTransaction();
      try {
        const result = await work();
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    },
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

import { makeMockConnection, makeMockPool } from '../test-utils/mockMysqlPool';
import { getPool } from './pool';
import { createRafflePayouts, isRafflePayoutPaid, payRafflePayout } from './rafflePayouts';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createRafflePayouts', () => {
  it('inserts one row per winner in a single statement and returns their ids in draw order', async () => {
    const pool = makeMockPool();
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 2 }, []])
      .mockResolvedValueOnce([[{ id: '11', twitch_username: 'b' }, { id: '10', twitch_username: 'a' }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await createRafflePayouts('draw-1', 7, ['a', 'b'], 50)).toEqual([
      { id: '10', twitchUsername: 'a' },
      { id: '11', twitchUsername: 'b' },
    ]);
    expect(pool.execute.mock.calls[0]![0]).toContain('VALUES (?, ?, ?, ?), (?, ?, ?, ?)');
    expect(pool.execute.mock.calls[0]![1]).toEqual(['draw-1', 7, 'a', 50, 'draw-1', 7, 'b', 50]);
    expect(pool.execute.mock.calls[1]![1]).toEqual(['draw-1']);
  });

  it('throws if a winner\'s row is missing after the insert', async () => {
    const pool = makeMockPool();
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }, []]).mockResolvedValueOnce([[], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(createRafflePayouts('draw-1', 7, ['a'], 50)).rejects.toThrow('raffle_payout row for a missing');
  });
});

describe('isRafflePayoutPaid', () => {
  /** Builds a pool whose connection's locking read sees `rows`. */
  function poolWithRows(rows: unknown[]) {
    const conn = makeMockConnection();
    conn.execute.mockImplementation(async (sql: string) => (sql.startsWith('SELECT') ? [rows, []] : [{}, []]));
    vi.mocked(getPool).mockReturnValue(makeMockPool({ connection: conn }) as any);
    return conn;
  }

  it.each([[null, false], [new Date(), true]])('reports paid_at %j as paid=%j', async (paidAt, expected) => {
    poolWithRows([{ paid_at: paidAt }]);
    expect(await isRafflePayoutPaid('10')).toBe(expected);
  });

  it('reads with a share lock, under a short lock wait, inside a transaction', async () => {
    const conn = poolWithRows([{ paid_at: null }]);
    await isRafflePayoutPaid('10');
    const statements = conn.execute.mock.calls.map(([sql]) => sql as string);
    expect(statements).toEqual([
      'SET SESSION innodb_lock_wait_timeout = 5',
      expect.stringMatching(/FROM raffle_payout WHERE id = \? FOR SHARE$/),
      'SET SESSION innodb_lock_wait_timeout = DEFAULT',
    ]);
    expect(conn.beginTransaction).toHaveBeenCalledOnce();
    expect(conn.commit).toHaveBeenCalledOnce();
    expect(conn.release).toHaveBeenCalledOnce();
  });

  it('throws when the row does not exist', async () => {
    const conn = poolWithRows([]);
    await expect(isRafflePayoutPaid('99')).rejects.toThrow('raffle_payout 99 not found');
    expect(conn.rollback).toHaveBeenCalledOnce();
  });
});

describe('payRafflePayout', () => {
  /** Builds a pool whose transaction connection sees `row` for the locked payout. */
  function poolWithRow(row: Record<string, unknown> | undefined) {
    const conn = makeMockConnection();
    conn.execute
      .mockResolvedValueOnce([row ? [row] : [], []]) // SELECT … FOR UPDATE
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]) // loyalty_points upsert
      .mockResolvedValueOnce([[{ balance: 150 }], []]) // balance read-back
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]); // mark paid
    const pool = makeMockPool({ connection: conn });
    vi.mocked(getPool).mockReturnValue(pool as any);
    return conn;
  }

  it('credits an unpaid row and marks it paid in the same transaction', async () => {
    const conn = poolWithRow({ streamer_id: 7, twitch_username: 'a', amount: 50, paid_at: null });
    expect(await payRafflePayout('10')).toBe('paid');
    expect(conn.execute.mock.calls[0]![0]).toContain('FOR UPDATE');
    expect(conn.execute.mock.calls[1]![1]).toEqual([7, 'a', 50, 2_147_483_647, 50, 2_147_483_647]);
    expect(conn.execute.mock.calls[3]![0]).toContain('SET paid_at = CURRENT_TIMESTAMP');
    expect(conn.execute.mock.calls[3]![1]).toEqual(['10']);
    expect(conn.commit).toHaveBeenCalledOnce();
  });

  it('does not credit a row an earlier attempt already paid', async () => {
    const conn = poolWithRow({ streamer_id: 7, twitch_username: 'a', amount: 50, paid_at: new Date() });
    expect(await payRafflePayout('10')).toBe('already_paid');
    expect(conn.execute).toHaveBeenCalledOnce();
  });

  it('rolls back and throws when the row does not exist', async () => {
    const conn = poolWithRow(undefined);
    await expect(payRafflePayout('99')).rejects.toThrow('raffle_payout 99 not found');
    expect(conn.rollback).toHaveBeenCalledOnce();
  });
});
