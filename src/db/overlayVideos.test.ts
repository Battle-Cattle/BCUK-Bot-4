import { describe, it, expect, vi, beforeEach } from 'vitest';

// `withTransaction`/`withTransactionOrNotFound` are reimplemented here (rather than via
// `importOriginal`) so this test doesn't pull in pool.ts's real `../shared/config` import
// chain, which throws in a test environment with no DISCORD_TOKEN etc. set. The logic
// mirrors pool.ts's real implementation exactly, driven by the same mocked `getPool()`.
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
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  };
  const withTransactionOrNotFound = async (
    work: (conn: unknown, notFound: () => never) => Promise<unknown>,
  ) => {
    const notFoundSignal = new Error('withTransactionOrNotFound: not found');
    try {
      return await withTransaction((conn) => work(conn, () => { throw notFoundSignal; }));
    } catch (err) {
      if (err === notFoundSignal) return null;
      throw err;
    }
  };
  return { getPool, withTransaction, withTransactionOrNotFound };
});
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import {
  getVideosForStreamer,
  addVideo,
  deleteVideo,
  getRewardsForStreamer,
  saveRewardWithVideos,
  deleteReward,
  getVideosForReward,
} from './overlayVideos';
import { makeMockPool } from '../test-utils/mockMysqlPool';

/** Builds a fake mysql pool whose `execute`/`query` resolve to the given rows/meta. */
function makePool(rows: unknown[] = [], meta: unknown = {}) {
  return makeMockPool({ rows, meta });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getVideosForStreamer ─────────────────────────────────────────────────────

describe('getVideosForStreamer', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getVideosForStreamer(1)).toEqual([]);
  });

  it('maps rows correctly', async () => {
    const now = new Date();
    const rows = [{ id: 10, streamer_id: 1, name: 'Intro', filename: 'intro.mp4', created_at: now }];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const [v] = await getVideosForStreamer(1);
    expect(v!.id).toBe(10);
    expect(v!.name).toBe('Intro');
    expect(v!.filename).toBe('intro.mp4');
    expect(v!.created_at).toBe(now);
  });

  it('queries with the given streamerId', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getVideosForStreamer(42);
    expect(pool.execute.mock.calls[0]![1]).toContain(42);
  });
});

// ─── addVideo ────────────────────────────────────────────────────────────────

describe('addVideo', () => {
  it('returns the insertId from the result', async () => {
    const pool = makePool();
    pool.execute.mockResolvedValue([{ insertId: 99 }, []]);  // ResultSetHeader format
    vi.mocked(getPool).mockReturnValue(pool as any);
    const id = await addVideo(1, 'Clip', 'clip.mp4');
    expect(id).toBe(99);
  });

  it('passes streamerId, name, filename to execute', async () => {
    const pool = makePool();
    pool.execute.mockResolvedValue([{ insertId: 1 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await addVideo(5, 'MyVid', 'vid.mp4');
    expect(pool.execute.mock.calls[0]![1]).toEqual([5, 'MyVid', 'vid.mp4']);
  });
});

// ─── deleteVideo ──────────────────────────────────────────────────────────────

describe('deleteVideo', () => {
  it('returns null when video not found', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute.mockResolvedValueOnce([[], []]);  // SELECT returns no rows
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await deleteVideo(99, 1);
    expect(result).toBeNull();
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('returns null when DELETE affects 0 rows', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([[{ filename: 'old.mp4' }], []])  // SELECT: rows
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);         // DELETE: ResultSetHeader
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await deleteVideo(1, 1);
    expect(result).toBeNull();
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('returns filename on success', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([[{ filename: 'clip.mp4' }], []])  // SELECT: rows
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);          // DELETE: ResultSetHeader
    vi.mocked(getPool).mockReturnValue(pool as any);
    const result = await deleteVideo(1, 1);
    expect(result).toBe('clip.mp4');
    expect(conn.commit).toHaveBeenCalled();
  });

  it('releases connection even when an error is thrown', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute.mockRejectedValue(new Error('DB error'));
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(deleteVideo(1, 1)).rejects.toThrow('DB error');
    expect(conn.release).toHaveBeenCalled();
  });
});

// ─── getRewardsForStreamer ─────────────────────────────────────────────────────

describe('getRewardsForStreamer', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getRewardsForStreamer(1)).toEqual([]);
  });

  it('groups videos under their reward', async () => {
    const rows = [
      { id: 1, streamer_id: 1, twitch_reward_id: 'rwdA', video_id: 10, weight: 2, name: 'Intro', filename: 'intro.mp4' },
      { id: 1, streamer_id: 1, twitch_reward_id: 'rwdA', video_id: 11, weight: 1, name: 'Outro', filename: 'outro.mp4' },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getRewardsForStreamer(1);
    expect(result).toHaveLength(1);
    expect(result[0]!.twitch_reward_id).toBe('rwdA');
    expect(result[0]!.videos).toHaveLength(2);
    expect(result[0]!.videos[0]!.weight).toBe(2);
  });

  it('handles multiple rewards', async () => {
    const rows = [
      { id: 1, streamer_id: 1, twitch_reward_id: 'rwdA', video_id: 10, weight: 1, name: 'A', filename: 'a.mp4' },
      { id: 2, streamer_id: 1, twitch_reward_id: 'rwdB', video_id: 20, weight: 3, name: 'B', filename: 'b.mp4' },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getRewardsForStreamer(1);
    expect(result).toHaveLength(2);
  });

  it('skips null video_id rows (reward with no videos)', async () => {
    const rows = [{ id: 1, streamer_id: 1, twitch_reward_id: 'rwdA', video_id: null, weight: null, name: null, filename: null }];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getRewardsForStreamer(1);
    expect(result).toHaveLength(1);
    expect(result[0]!.videos).toHaveLength(0);
  });
});

// ─── saveRewardWithVideos ─────────────────────────────────────────────────────

describe('saveRewardWithVideos', () => {
  it('upserts the reward and replaces its videos on one transaction, then commits', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ insertId: 42 }, []])     // upsert reward
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])  // DELETE
      .mockResolvedValueOnce([[{ id: 5 }], []])          // validate-SELECT IN
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]); // INSERT
    vi.mocked(getPool).mockReturnValue(pool as any);
    const id = await saveRewardWithVideos(1, 'reward-uuid', [{ videoId: 5, weight: 2 }]);
    expect(id).toBe(42);
    expect(pool.getConnection).toHaveBeenCalledTimes(1);
    expect(pool.execute).not.toHaveBeenCalled();
    const [upsertSql, upsertParams] = conn.execute.mock.calls[0]!;
    expect(upsertSql).toContain('INSERT INTO overlay_reward');
    expect(upsertParams).toEqual([1, 'reward-uuid']);
    expect(conn.execute.mock.calls[1]![1]).toEqual([42]);
    expect(conn.execute.mock.calls[3]![1]).toEqual([42, 5, 2]);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
  });

  it('rolls back the reward upsert when a video does not belong to the streamer', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ insertId: 42 }, []])     // upsert reward
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])  // DELETE
      .mockResolvedValueOnce([[], []]);                  // validate-SELECT IN: none owned
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(saveRewardWithVideos(1, 'reward-uuid', [{ videoId: 999, weight: 1 }]))
      .rejects.toThrow('does not belong to streamer');
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  it('clamps weight to a minimum of 1', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ insertId: 42 }, []])     // upsert reward
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])  // DELETE
      .mockResolvedValueOnce([[{ id: 5 }], []])          // validate-SELECT IN
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]); // INSERT
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveRewardWithVideos(1, 'reward-uuid', [{ videoId: 5, weight: 0 }]);
    expect(conn.execute.mock.calls[3]![1]).toEqual([42, 5, 1]);  // Math.max(1, 0) = 1
  });

  it('issues a single validate query and a single multi-row insert regardless of video count', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ insertId: 42 }, []])                  // upsert reward
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])               // DELETE
      .mockResolvedValueOnce([[{ id: 5 }, { id: 6 }, { id: 7 }], []]) // validate-SELECT IN
      .mockResolvedValueOnce([{ affectedRows: 3 }, []]);              // INSERT
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveRewardWithVideos(1, 'reward-uuid', [
      { videoId: 5, weight: 1 },
      { videoId: 6, weight: 2 },
      { videoId: 7, weight: 3 },
    ]);
    expect(conn.execute).toHaveBeenCalledTimes(4);
    expect(conn.commit).toHaveBeenCalled();
  });

  it('does not validate or insert videos when the list is empty', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ insertId: 42 }, []])     // upsert reward
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]); // DELETE
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await saveRewardWithVideos(1, 'reward-uuid', [])).toBe(42);
    expect(conn.execute).toHaveBeenCalledTimes(2);
    expect(conn.commit).toHaveBeenCalled();
  });

  it('rolls back and releases the connection when a query fails', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([{ insertId: 42 }, []])
      .mockRejectedValueOnce(new Error('DB crash'));
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(saveRewardWithVideos(1, 'reward-uuid', [])).rejects.toThrow('DB crash');
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });
});

// ─── deleteReward ─────────────────────────────────────────────────────────────

describe('deleteReward', () => {
  it('executes DELETE with rewardId and streamerId', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await deleteReward(3, 7);
    expect(pool.execute.mock.calls[0]![1]).toEqual([3, 7]);
  });
});

// ─── getVideosForReward ───────────────────────────────────────────────────────

describe('getVideosForReward', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getVideosForReward('rwd1', 1)).toEqual([]);
  });

  it('maps filename and weight', async () => {
    const rows = [{ filename: 'clip.mp4', weight: 3 }, { filename: 'outro.mp4', weight: 1 }];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getVideosForReward('rwd1', 1);
    expect(result[0]).toEqual({ file: 'clip.mp4', weight: 3 });
    expect(result[1]).toEqual({ file: 'outro.mp4', weight: 1 });
  });

  it('queries with twitchRewardId and streamerId', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getVideosForReward('rwdABC', 5);
    expect(pool.execute.mock.calls[0]![1]).toEqual(['rwdABC', 5]);
  });
});
