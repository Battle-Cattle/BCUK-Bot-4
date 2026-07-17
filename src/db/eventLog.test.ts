import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import { recordStreamerEvent, getRecentStreamerEvents } from './eventLog';
import { makeMockPool } from '../test-utils/mockMysqlPool';

/** Builds a fake mysql pool whose `execute`/`query` resolve to the given rows/meta. */
function makePool(rows: unknown[] = [], meta: unknown = {}) {
  return makeMockPool({ rows, meta });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordStreamerEvent', () => {
  it('inserts the event and prunes the streamer down to the retention cap', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);

    await recordStreamerEvent(5, 'follow', 'someviewer', null);

    expect(pool.execute).toHaveBeenCalledTimes(2);
    const [insertSql, insertParams] = pool.execute.mock.calls[0];
    expect(insertSql).toContain('INSERT INTO streamer_event_log');
    expect(insertParams).toEqual([5, 'follow', 'someviewer', null]);

    const [deleteSql, deleteParams] = pool.execute.mock.calls[1];
    expect(deleteSql).toContain('DELETE FROM streamer_event_log');
    expect(deleteSql).toContain('LIMIT 200');
    expect(deleteParams).toEqual([5, 5]);
  });

  it('passes through a non-null detail string', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);

    await recordStreamerEvent(5, 'redemption', 'someviewer', 'Redeemed Hydrate: drink water!');

    const [, insertParams] = pool.execute.mock.calls[0];
    expect(insertParams).toEqual([5, 'redemption', 'someviewer', 'Redeemed Hydrate: drink water!']);
  });

  it('does not run the prune DELETE until the INSERT has resolved', async () => {
    let resolveInsert: (() => void) | undefined;
    const insertPromise = new Promise<[unknown, unknown]>((resolve) => {
      resolveInsert = () => resolve([{ affectedRows: 1 }, []]);
    });
    const pool = {
      execute: vi.fn()
        .mockImplementationOnce(() => insertPromise)
        .mockImplementationOnce(async () => [{ affectedRows: 0 }, []]),
    };
    vi.mocked(getPool).mockReturnValue(pool as any);

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
