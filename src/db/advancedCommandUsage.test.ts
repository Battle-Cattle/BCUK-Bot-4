import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => {
  const getPool = vi.fn();
  const signal = new Error('not found');
  return {
    getPool,
    withTransactionOrNotFound: async (work: (conn: unknown, nf: () => never) => Promise<unknown>) => {
      const conn = await getPool().getConnection();
      try {
        const result = await work(conn, () => { throw signal; });
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback();
        if (err === signal) return null;
        throw err;
      } finally {
        conn.release();
      }
    },
  };
});
vi.mock('mysql2/promise', () => ({ default: {} }));

import { makeMockPool, type MockPool } from '../test-utils/mockMysqlPool';
import { getPool } from './pool';
import {
  recordAdvancedCommandUsage, countAdvancedCommandUses, resolveAdvancedCommandUsage,
  getAdvancedCommandUsageStreamerId, listPendingAdvancedCommandUsage, listRecentAdvancedCommandUsage,
} from './advancedCommandUsage';

let pool: MockPool;

beforeEach(() => {
  vi.clearAllMocks();
  pool = makeMockPool();
  vi.mocked(getPool).mockReturnValue(pool as any);
});

describe('recordAdvancedCommandUsage', () => {
  it('inserts the use', async () => {
    const start = new Date('2026-10-15T18:00:00Z');
    await recordAdvancedCommandUsage({
      eventId: 'e1', commandId: 7, streamerId: 3, commandName: 'Hydrate', source: 'chat',
      twitchUsername: 'viewer', pointsSpent: 100, streamStartedAt: start, status: 'pending',
    });
    expect(pool.execute.mock.calls[0]![1]).toEqual(['e1', 7, 3, 'Hydrate', 'chat', 'viewer', 100, start, 'pending']);
  });
});

describe('countAdvancedCommandUses', () => {
  it('counts a live stream\'s non-refunded chat uses, parsing the BIGINT count', async () => {
    const start = new Date('2026-10-15T18:00:00Z');
    pool.execute.mockResolvedValueOnce([[{ uses: '4' }], []]);
    expect(await countAdvancedCommandUses(7, { streamStartedAt: start })).toBe(4);
    const [sql, params] = pool.execute.mock.calls[0]!;
    expect(sql).toContain("status <> 'refunded'");
    expect(sql).toContain('stream_started_at = ?');
    expect(params).toEqual([7, start]);
  });

  it('counts one viewer\'s offline uses since a time', async () => {
    const since = new Date('2026-10-15T06:00:00Z');
    pool.execute.mockResolvedValueOnce([[{ uses: 1 }], []]);
    expect(await countAdvancedCommandUses(7, { offlineSince: since }, 'viewer')).toBe(1);
    const [sql, params] = pool.execute.mock.calls[0]!;
    expect(sql).toContain('stream_started_at IS NULL AND triggered_at >= ?');
    expect(params).toEqual([7, since, 'viewer']);
  });
});

describe('resolveAdvancedCommandUsage', () => {
  it('resolves a pending use and returns what a refund needs', async () => {
    pool._conn.execute
      .mockResolvedValueOnce([[{ streamer_id: 3, command_name: 'Hydrate', twitch_username: 'viewer', points_spent: 100 }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const result = await resolveAdvancedCommandUsage('e1', { status: 'refunded', refundReason: 'companion_error', errorMessage: 'x'.repeat(300) });
    expect(result).toEqual({ streamerId: 3, commandName: 'Hydrate', twitchUsername: 'viewer', pointsSpent: 100 });
    expect(pool._conn.execute.mock.calls[0]![0]).toContain("status = 'pending' FOR UPDATE");
    const params = pool._conn.execute.mock.calls[1]![1];
    expect(params[0]).toBe('refunded');
    expect(params[1]).toBe('companion_error');
    expect(params[2]).toHaveLength(255);
  });

  it('returns null when the use is no longer pending', async () => {
    pool._conn.execute.mockResolvedValueOnce([[], []]);
    expect(await resolveAdvancedCommandUsage('e1', { status: 'succeeded' })).toBeNull();
    expect(pool._conn.execute).toHaveBeenCalledOnce();
  });
});

describe('lookups', () => {
  it('finds the streamer a use belongs to', async () => {
    pool.execute.mockResolvedValueOnce([[{ streamer_id: 3 }], []]).mockResolvedValueOnce([[], []]);
    expect(await getAdvancedCommandUsageStreamerId('e1')).toBe(3);
    expect(await getAdvancedCommandUsageStreamerId('nope')).toBeNull();
  });

  it('lists pending event ids', async () => {
    pool.execute.mockResolvedValueOnce([[{ event_id: 'a' }, { event_id: 'b' }], []]);
    expect(await listPendingAdvancedCommandUsage()).toEqual(['a', 'b']);
  });

  it('lists recent uses for the usage log', async () => {
    const at = new Date();
    pool.execute.mockResolvedValueOnce([[{
      event_id: 'e1', command_name: 'Hydrate', source: 'streamdeck', twitch_username: null, points_spent: 0,
      status: 'no_ack_needed', refund_reason: null, error_message: null, triggered_at: at,
    }], []]);
    expect(await listRecentAdvancedCommandUsage(3, 50)).toEqual([{
      eventId: 'e1', commandName: 'Hydrate', source: 'streamdeck', twitchUsername: null, pointsSpent: 0,
      status: 'no_ack_needed', refundReason: null, errorMessage: null, triggeredAt: at,
    }]);
    expect(pool.execute.mock.calls[0]![1]).toEqual([3, 50]);
  });
});
