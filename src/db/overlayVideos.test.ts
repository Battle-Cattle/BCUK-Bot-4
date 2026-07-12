import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import {
  getVideosForStreamer,
  addVideo,
  getVideoById,
  deleteVideo,
  getRewardsForStreamer,
  upsertReward,
  setRewardVideos,
  deleteReward,
  getVideosForReward,
} from './overlayVideos';
import { makeMockPool } from '../test-utils/mockMysqlPool';

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
    expect(v.id).toBe(10);
    expect(v.name).toBe('Intro');
    expect(v.filename).toBe('intro.mp4');
    expect(v.created_at).toBe(now);
  });

  it('queries with the given streamerId', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getVideosForStreamer(42);
    expect(pool.execute.mock.calls[0][1]).toContain(42);
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
    expect(pool.execute.mock.calls[0][1]).toEqual([5, 'MyVid', 'vid.mp4']);
  });
});

// ─── getVideoById ─────────────────────────────────────────────────────────────

describe('getVideoById', () => {
  it('returns null when no rows found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getVideoById(1, 1)).toBeNull();
  });

  it('maps the found row', async () => {
    const now = new Date();
    const row = { id: 5, streamer_id: 2, name: 'Clip', filename: 'clip.mp4', created_at: now };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const v = await getVideoById(5, 2);
    expect(v!.id).toBe(5);
    expect(v!.name).toBe('Clip');
  });

  it('queries with videoId and streamerId', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getVideoById(7, 3);
    expect(pool.execute.mock.calls[0][1]).toEqual([7, 3]);
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
    expect(result[0].twitch_reward_id).toBe('rwdA');
    expect(result[0].videos).toHaveLength(2);
    expect(result[0].videos[0].weight).toBe(2);
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
    expect(result[0].videos).toHaveLength(0);
  });
});

// ─── upsertReward ─────────────────────────────────────────────────────────────

describe('upsertReward', () => {
  it('returns the insertId', async () => {
    const pool = makePool();
    pool.execute.mockResolvedValue([{ insertId: 5 }, []]);  // ResultSetHeader format
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await upsertReward(1, 'reward123')).toBe(5);
  });

  it('passes streamerId and twitchRewardId to execute', async () => {
    const pool = makePool();
    pool.execute.mockResolvedValue([{ insertId: 1 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await upsertReward(7, 'rewardXYZ');
    expect(pool.execute.mock.calls[0][1]).toEqual([7, 'rewardXYZ']);
  });
});

// ─── setRewardVideos ──────────────────────────────────────────────────────────

describe('setRewardVideos', () => {
  it('rolls back and returns when reward does not belong to streamer', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute.mockResolvedValueOnce([[], []]);  // ownership check: no rows
    vi.mocked(getPool).mockReturnValue(pool as any);
    await setRewardVideos(1, 99, [{ videoId: 5, weight: 2 }]);
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('commits when all videos belong to streamer', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([[{ id: 1 }], []])         // ownership check: rows
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])  // DELETE: ResultSetHeader
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);  // INSERT: ResultSetHeader
    vi.mocked(getPool).mockReturnValue(pool as any);
    await setRewardVideos(1, 1, [{ videoId: 5, weight: 2 }]);
    expect(conn.commit).toHaveBeenCalled();
  });

  it('throws when a video does not belong to the streamer', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([[{ id: 1 }], []])         // ownership check: rows
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])  // DELETE: ResultSetHeader
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);  // INSERT: affectedRows=0 → wrong streamer
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(setRewardVideos(1, 1, [{ videoId: 999, weight: 1 }])).rejects.toThrow('does not belong to streamer');
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('releases connection on error', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([[{ id: 1 }], []])
      .mockRejectedValueOnce(new Error('DB crash'));
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(setRewardVideos(1, 1, [])).rejects.toThrow('DB crash');
    expect(conn.release).toHaveBeenCalled();
  });

  it('clamps weight to minimum of 1 via Math.max', async () => {
    const pool = makePool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([[{ id: 1 }], []])         // ownership check
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])  // DELETE
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]); // INSERT
    vi.mocked(getPool).mockReturnValue(pool as any);
    await setRewardVideos(1, 1, [{ videoId: 5, weight: 0 }]);
    const insertParams: unknown[] = conn.execute.mock.calls[2][1];
    expect(insertParams[1]).toBe(1);  // Math.max(1, 0) = 1
  });
});

// ─── deleteReward ─────────────────────────────────────────────────────────────

describe('deleteReward', () => {
  it('executes DELETE with rewardId and streamerId', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await deleteReward(3, 7);
    expect(pool.execute.mock.calls[0][1]).toEqual([3, 7]);
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
    expect(pool.execute.mock.calls[0][1]).toEqual(['rwdABC', 5]);
  });
});
