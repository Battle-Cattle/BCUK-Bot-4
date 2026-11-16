import { describe, it, expect, vi, beforeEach } from 'vitest';

// withTransaction/withTransactionOrNotFound are reimplemented here so this test doesn't pull in
// pool.ts's real config chain (see loyaltyPoints.test.ts).
vi.mock('./pool', () => {
  const getPool = vi.fn();
  const withTransaction = async (work: (conn: unknown) => Promise<unknown>) => {
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      const result = await work(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  };
  const signal = new Error('not found');
  return {
    getPool,
    withTransaction,
    withTransactionOrNotFound: async (work: (conn: unknown, nf: () => never) => Promise<unknown>) => {
      try {
        return await withTransaction((conn) => work(conn, () => { throw signal; }));
      } catch (err) {
        if (err === signal) return null;
        throw err;
      }
    },
  };
});
vi.mock('mysql2/promise', () => ({ default: {} }));

import { makeMockPool, type MockPool } from '../test-utils/mockMysqlPool';
import { getPool } from './pool';
import { saveAdvancedCommandEffects, setAdvancedCommandAlertAsset } from './advancedCommandEffects';

let pool: MockPool;

beforeEach(() => {
  vi.clearAllMocks();
  pool = makeMockPool();
  vi.mocked(getPool).mockReturnValue(pool as any);
});

// attachEffects is covered through listAdvancedCommands/getAdvancedCommand in advancedCommands.test.ts.

describe('saveAdvancedCommandEffects', () => {
  it('replaces params, videos (owned) and alert in one transaction', async () => {
    pool._conn.execute
      .mockResolvedValueOnce([[{ id: 7 }], []]) // ownership
      .mockResolvedValueOnce([{}, []]) // delete params
      .mockResolvedValueOnce([{}, []]) // insert params
      .mockResolvedValueOnce([{}, []]) // delete videos
      .mockResolvedValueOnce([[{ id: 2 }], []]) // owned videos
      .mockResolvedValueOnce([{}, []]) // insert videos
      .mockResolvedValueOnce([{}, []]); // upsert alert

    const result = await saveAdvancedCommandEffects(3, 7, {
      params: [{ key: 'color', value: 'red' }],
      videos: [{ videoId: 2, weight: 2 }],
      alert: { messageTemplate: 'Hi', durationMs: 4000, textAnimation: 'none' },
    });
    expect(result).toEqual([]);
    const calls = pool._conn.execute.mock.calls;
    expect(calls[2]![1]).toEqual([7, 'color', 'red']);
    expect(calls[5]![1]).toEqual([7, 2, 2]);
    expect(calls[6]![0]).toContain('INSERT INTO advanced_command_alert');
    expect(calls[6]![0]).not.toContain('image_filename');
    expect(pool._conn.commit).toHaveBeenCalled();
  });

  it('rolls back when a video belongs to another streamer', async () => {
    pool._conn.execute
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([{}, []])
      .mockResolvedValueOnce([{}, []])
      .mockResolvedValueOnce([[], []]);
    await expect(saveAdvancedCommandEffects(3, 7, { params: [], videos: [{ videoId: 9, weight: 1 }], alert: null }))
      .rejects.toThrow('not owned');
    expect(pool._conn.rollback).toHaveBeenCalled();
  });

  it('removes the alert and returns its orphaned asset filenames', async () => {
    pool._conn.execute
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([{}, []]) // delete params
      .mockResolvedValueOnce([{}, []]) // delete videos
      .mockResolvedValueOnce([[{ image_filename: 'a.gif', sound_filename: 'b.mp3' }], []])
      .mockResolvedValueOnce([{}, []]);
    expect(await saveAdvancedCommandEffects(3, 7, { params: [], videos: [], alert: null })).toEqual(['a.gif', 'b.mp3']);
  });

  it('returns null for a command that is not the streamer\'s', async () => {
    pool._conn.execute.mockResolvedValueOnce([[], []]);
    expect(await saveAdvancedCommandEffects(3, 7, { params: [], videos: [], alert: null })).toBeNull();
  });
});

describe('setAdvancedCommandAlertAsset', () => {
  it('sets the image and returns the previous filename', async () => {
    pool._conn.execute.mockResolvedValueOnce([[{ filename: 'old.png' }], []]).mockResolvedValueOnce([{}, []]);
    expect(await setAdvancedCommandAlertAsset(3, 7, 'image', 'new.png')).toEqual({ previous: 'old.png' });
    expect(pool._conn.execute.mock.calls[1]![0]).toContain('SET image_filename = ?');
    expect(pool._conn.execute.mock.calls[1]![1]).toEqual(['new.png', 7]);
  });

  it('clears the sound', async () => {
    pool._conn.execute.mockResolvedValueOnce([[{ filename: null }], []]).mockResolvedValueOnce([{}, []]);
    expect(await setAdvancedCommandAlertAsset(3, 7, 'sound', null)).toEqual({ previous: null });
    expect(pool._conn.execute.mock.calls[1]![0]).toContain('SET sound_filename = ?');
  });

  it('returns null when the command has no alert or is not the streamer\'s', async () => {
    pool._conn.execute.mockResolvedValueOnce([[], []]);
    expect(await setAdvancedCommandAlertAsset(3, 7, 'image', 'x.png')).toBeNull();
  });
});
