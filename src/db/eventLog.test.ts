import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import { recordStreamerEvent, getRecentStreamerEvents, __resetEventLogPruneCountersForTests } from './eventLog';
import { makeMockPool } from '../test-utils/mockMysqlPool';

// Matches PRUNE_EVERY_N_INSERTS in eventLog.ts — the prune DELETE only runs on every Nth insert.
const PRUNE_EVERY_N_INSERTS = 10;

/** Builds a fake mysql pool whose `execute`/`query` resolve to the given rows/meta. */
function makePool(rows: unknown[] = [], meta: unknown = {}) {
  return makeMockPool({ rows, meta });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetEventLogPruneCountersForTests();
});

describe('recordStreamerEvent', () => {
  it('inserts the event without pruning while under the prune-cadence threshold', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(recordStreamerEvent(5, 'follow', 'someviewer', null)).resolves.toBe(true);

    expect(pool.execute).toHaveBeenCalledTimes(1);
    const [insertSql, insertParams] = pool.execute.mock.calls[0];
    expect(insertSql).toContain('INSERT INTO streamer_event_log');
    expect(insertParams).toEqual([5, 'follow', 'someviewer', null, null]);
  });

  it('prunes the streamer down to the retention cap once the prune-cadence threshold is reached', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);

    for (let i = 0; i < PRUNE_EVERY_N_INSERTS - 1; i++) {
      await recordStreamerEvent(5, 'follow', 'someviewer', null);
    }
    pool.execute.mockClear();

    await expect(recordStreamerEvent(5, 'follow', 'someviewer', null)).resolves.toBe(true);

    expect(pool.execute).toHaveBeenCalledTimes(2);
    const [deleteSql, deleteParams] = pool.execute.mock.calls[1];
    expect(deleteSql).toContain('DELETE FROM streamer_event_log');
    expect(deleteSql).toContain('LIMIT 200');
    expect(deleteParams).toEqual([5, 5]);
  });

  it('retries pruning on the very next insert when the prune DELETE fails, instead of waiting another full cadence', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);

    for (let i = 0; i < PRUNE_EVERY_N_INSERTS - 1; i++) {
      await recordStreamerEvent(5, 'follow', 'someviewer', null);
    }
    pool.execute.mockClear();
    // The threshold-reaching insert's DELETE fails.
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]) // INSERT
      .mockRejectedValueOnce(new Error('DB down')); // DELETE

    await expect(recordStreamerEvent(5, 'follow', 'someviewer', null)).rejects.toThrow('DB down');
    pool.execute.mockClear();
    pool.execute.mockResolvedValue([{ affectedRows: 1 }, []]);

    // The counter must not have been cleared by the failed prune — this next insert (the first
    // of a "quiet" streak) should retry the prune immediately rather than needing
    // PRUNE_EVERY_N_INSERTS more successful inserts first.
    await expect(recordStreamerEvent(5, 'follow', 'someviewer', null)).resolves.toBe(true);

    expect(pool.execute).toHaveBeenCalledTimes(2);
    const [deleteSql] = pool.execute.mock.calls[1];
    expect(deleteSql).toContain('DELETE FROM streamer_event_log');
  });

  it('shares one prune DELETE when a concurrent event lands for the same streamer while the first prune is still in flight', async () => {
    let resolveDelete!: () => void;
    const deletePromise = new Promise<[unknown, unknown]>((resolve) => {
      resolveDelete = () => resolve([{ affectedRows: 5 }, []]);
    });
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);

    for (let i = 0; i < PRUNE_EVERY_N_INSERTS - 1; i++) {
      await recordStreamerEvent(5, 'follow', 'someviewer', null);
    }
    pool.execute.mockClear();

    // Call A's insert reaches the prune threshold; its DELETE is held pending.
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]) // call A's INSERT
      .mockImplementationOnce(() => deletePromise); // call A's DELETE, held pending
    const callA = recordStreamerEvent(5, 'follow', 'someviewer', null);
    await Promise.resolve();
    await Promise.resolve();

    // Since dispatchNotification fires EventSub handlers without awaiting them (see
    // eventLog.ts's pruneInFlight doc comment), a second event for the same streamer can land
    // while call A's DELETE is still pending — the in-memory counter isn't reset until that
    // DELETE succeeds, so a naive implementation would compute a second threshold-reaching
    // count and start its own redundant DELETE.
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }, []]); // call B's INSERT
    const callB = recordStreamerEvent(5, 'follow', 'someviewer', null);
    await Promise.resolve();
    await Promise.resolve();

    resolveDelete();
    await expect(callA).resolves.toBe(true);
    await expect(callB).resolves.toBe(true);

    // Only 3 execute calls total (A's INSERT, A's DELETE, B's INSERT) — B piggybacks on A's
    // in-flight prune instead of issuing a second DELETE.
    expect(pool.execute).toHaveBeenCalledTimes(3);
    const deleteCalls = pool.execute.mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM streamer_event_log'));
    expect(deleteCalls).toHaveLength(1);
  });

  it('tracks the prune-cadence counter independently per streamer', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);

    for (let i = 0; i < PRUNE_EVERY_N_INSERTS - 1; i++) {
      await recordStreamerEvent(5, 'follow', 'someviewer', null);
    }
    pool.execute.mockClear();

    // A different streamer's first insert should not inherit streamer 5's near-threshold count.
    await recordStreamerEvent(7, 'follow', 'otherviewer', null);

    expect(pool.execute).toHaveBeenCalledTimes(1);
  });

  it('passes through a non-null detail string', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);

    await recordStreamerEvent(5, 'redemption', 'someviewer', 'Redeemed Hydrate: drink water!');

    const [, insertParams] = pool.execute.mock.calls[0];
    expect(insertParams).toEqual([5, 'redemption', 'someviewer', 'Redeemed Hydrate: drink water!', null]);
  });

  it('passes a given redemptionId through as the fifth INSERT param', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);

    await recordStreamerEvent(5, 'redemption', 'someviewer', 'Redeemed Hydrate', 'redemption-abc');

    const [, insertParams] = pool.execute.mock.calls[0];
    expect(insertParams).toEqual([5, 'redemption', 'someviewer', 'Redeemed Hydrate', 'redemption-abc']);
  });

  it('silently no-ops on a duplicate-key INSERT when a redemptionId was given (retry of an already-recorded redemption)', async () => {
    const pool = {
      execute: vi.fn().mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' })),
    };
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(recordStreamerEvent(5, 'redemption', 'someviewer', null, 'redemption-abc')).resolves.toBe(false);

    // No prune DELETE either — nothing new was inserted.
    expect(pool.execute).toHaveBeenCalledTimes(1);
  });

  it('rethrows a duplicate-key INSERT error when no redemptionId was given', async () => {
    const dupError = Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
    const pool = { execute: vi.fn().mockRejectedValueOnce(dupError) };
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(recordStreamerEvent(5, 'follow', 'someviewer', null)).rejects.toThrow('dup');
  });

  it('rethrows a non-duplicate-key INSERT error even when a redemptionId was given', async () => {
    const otherError = Object.assign(new Error('connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
    const pool = { execute: vi.fn().mockRejectedValueOnce(otherError) };
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(recordStreamerEvent(5, 'redemption', 'someviewer', null, 'redemption-abc')).rejects.toThrow('connection lost');
  });

  it('does not run the prune DELETE until the INSERT has resolved', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);

    // Bring streamer 5 to one insert short of the prune-cadence threshold.
    for (let i = 0; i < PRUNE_EVERY_N_INSERTS - 1; i++) {
      await recordStreamerEvent(5, 'follow', 'someviewer', null);
    }
    pool.execute.mockClear();

    let resolveInsert: (() => void) | undefined;
    const insertPromise = new Promise<[unknown, unknown]>((resolve) => {
      resolveInsert = () => resolve([{ affectedRows: 1 }, []]);
    });
    pool.execute
      .mockImplementationOnce(() => insertPromise)
      .mockImplementationOnce(async () => [{ affectedRows: 0 }, []]);

    const recordPromise = recordStreamerEvent(5, 'follow', 'someviewer', null);

    // The DELETE must not have been issued while the INSERT is still pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(pool.execute).toHaveBeenCalledTimes(1);

    resolveInsert!();
    await recordPromise;

    expect(pool.execute).toHaveBeenCalledTimes(2);
  });
});

describe('getRecentStreamerEvents', () => {
  it('returns an empty array when no events are found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getRecentStreamerEvents(5, 20)).toEqual([]);
  });

  it('maps rows to StreamerEvent objects', async () => {
    const occurredAt = new Date('2026-07-17T12:00:00Z');
    const rows = [{ event_type: 'raid', display_name: 'raider1', detail: '12 viewers', occurred_at: occurredAt }];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);

    const events = await getRecentStreamerEvents(5, 20);

    expect(events).toEqual([{ eventType: 'raid', displayName: 'raider1', detail: '12 viewers', occurredAt }]);
  });

  it('queries with streamerId, ordered newest first, and inlines a valid integer limit', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getRecentStreamerEvents(5, 20);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('ORDER BY occurred_at DESC, id DESC');
    expect(sql).toContain('LIMIT 20');
    expect(params).toEqual([5]);
  });

  it('rejects a non-integer limit', async () => {
    await expect(getRecentStreamerEvents(5, 1.5)).rejects.toThrow('Invalid limit');
  });

  it('rejects a negative limit', async () => {
    await expect(getRecentStreamerEvents(5, -1)).rejects.toThrow('Invalid limit');
  });
});
