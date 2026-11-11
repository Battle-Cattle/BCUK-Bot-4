import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => {
  const getPool = vi.fn();
  const withTransactionOrNotFound = async (
    work: (conn: unknown, notFound: () => never) => Promise<unknown>,
  ) => {
    const signal = new Error('not found');
    const conn = await getPool().getConnection();
    try {
      return await work(conn, () => { throw signal; });
    } catch (err) {
      if (err === signal) return null;
      throw err;
    } finally {
      conn.release();
    }
  };
  return { getPool, withTransactionOrNotFound };
});
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import {
  listSharedVideos, listEnabledSharedVideos, getSharedVideo, addSharedVideo,
  renameSharedVideo, setSharedVideoEnabled, removeSharedVideo,
} from './sharedOverlayVideos';
import { makeMockPool } from '../test-utils/mockMysqlPool';
import { schemaFromMigrations } from '../test-utils/migrationSchema';

const row = { id: 1, name: 'Clap', filename: 'a.webm', uploaded_by: null, enabled: 1, created_at: new Date(0) };

beforeEach(() => { vi.clearAllMocks(); });

describe('shared_overlay_video schema', () => {
  const def = schemaFromMigrations().get('shared_overlay_video')!.definition;

  it('keeps the video with a null uploader when the uploader is deleted', () => {
    expect(def).toMatch(/FOREIGN KEY \(uploaded_by\) REFERENCES `user`\(discord_id\) ON DELETE SET NULL/);
  });

  it('never reuses a filename and defaults to enabled', () => {
    expect(def).toContain('UNIQUE KEY uq_shared_overlay_video_filename (filename)');
    expect(def).toMatch(/enabled\s+BOOLEAN\s+NOT NULL DEFAULT TRUE/);
  });
});

describe('shared overlay video queries', () => {
  it('lists all videos with the uploader login, null when unknown', async () => {
    const pool = makeMockPool();
    pool.execute.mockResolvedValueOnce([[{ ...row, uploader_login: 'bob' }, { ...row, id: 2, uploader_login: null }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    const out = await listSharedVideos();
    expect(out.map((v) => v.uploader_login)).toEqual(['bob', null]);
    expect(out[0]!.enabled).toBe(true);
  });

  it('lists only enabled videos', async () => {
    const pool = makeMockPool();
    pool.execute.mockResolvedValueOnce([[row], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(listEnabledSharedVideos()).resolves.toHaveLength(1);
    expect(pool.execute.mock.calls[0]![0]).toContain('enabled = TRUE');
  });

  it('gets one video, or null when missing', async () => {
    const pool = makeMockPool();
    pool.execute.mockResolvedValueOnce([[row], []]).mockResolvedValueOnce([[], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(getSharedVideo(1)).resolves.toMatchObject({ id: 1, name: 'Clap' });
    await expect(getSharedVideo(9)).resolves.toBeNull();
  });

  it('adds a video and returns the new id', async () => {
    const pool = makeMockPool();
    pool.execute.mockResolvedValueOnce([{ insertId: 4 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(addSharedVideo('Clap', 'a.webm', '123')).resolves.toBe(4);
    expect(pool.execute.mock.calls[0]![1]).toEqual(['Clap', 'a.webm', '123']);
  });

  it('rename and enable report not found for a missing id', async () => {
    const pool = makeMockPool();
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(renameSharedVideo(1, 'x')).resolves.toBe(true);
    await expect(renameSharedVideo(9, 'x')).resolves.toBe(false);
    await expect(setSharedVideoEnabled(1, false)).resolves.toBe(true);
    await expect(setSharedVideoEnabled(9, false)).resolves.toBe(false);
  });

  it('remove returns the filename, or null for a missing id', async () => {
    const pool = makeMockPool();
    pool._conn.execute
      .mockResolvedValueOnce([[{ filename: 'a.webm' }], []])
      .mockResolvedValueOnce([{}, []])
      .mockResolvedValueOnce([[], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(removeSharedVideo(1)).resolves.toBe('a.webm');
    await expect(removeSharedVideo(9)).resolves.toBeNull();
    expect(pool._conn.execute).toHaveBeenCalledTimes(3);
  });
});
