import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same pool mock as overlayVideos.test.ts: `withTransaction`/`withTransactionOrNotFound` mirror
// pool.ts's real implementation over the mocked `getPool()`, without pool.ts's config imports.
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
  addVideoToLibrary,
  getLibraryVideos,
  getImportedLibraryEntryIds,
  getLibraryVideoFilename,
  importLibraryVideo,
  removeLibraryVideo,
} from './overlayVideoLibrary';
import { makeMockPool } from '../test-utils/mockMysqlPool';
import { schemaFromMigrations } from '../test-utils/migrationSchema';

/** Builds a duplicate-entry error like mysql2 throws; the message names the colliding value and key. */
function duplicateEntryError(value: string, key: string) {
  const message = `Duplicate entry '${value}' for key 'overlay_video_library.${key}'`;
  return Object.assign(new Error(message), { code: 'ER_DUP_ENTRY', errno: 1062, sqlMessage: message });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── schema ──────────────────────────────────────────────────────────────────

describe('overlay video library schema', () => {
  const tables = schemaFromMigrations();
  const library = tables.get('overlay_video_library')!.definition;
  const video = tables.get('overlay_video')!.definition;

  it('keeps the entry, with no contributor, when the contributor\'s streamer row goes away', () => {
    expect(library).toMatch(/FOREIGN KEY \(contributor_streamer_id\) REFERENCES streamer\(id\) ON DELETE SET NULL/);
  });

  it('keeps the entry, with source_video_id NULL, when the contributor deletes their video', () => {
    expect(library).toMatch(/FOREIGN KEY \(source_video_id\) REFERENCES overlay_video\(id\) ON DELETE SET NULL/);
  });

  it('stops the same video being added twice while it exists, and library filenames colliding', () => {
    expect(library).toContain('UNIQUE KEY uq_overlay_video_library_source (source_video_id)');
    expect(library).toContain('UNIQUE KEY uq_overlay_video_library_filename (filename)');
  });

  it('keeps imported copies, with library_entry_id NULL, when the entry is removed', () => {
    expect(video).toMatch(/FOREIGN KEY \(library_entry_id\) REFERENCES overlay_video_library\(id\) ON DELETE SET NULL/);
  });
});

// ─── addVideoToLibrary ───────────────────────────────────────────────────────

describe('addVideoToLibrary', () => {
  it('inserts the entry copying the video name and returns the id and source filename', async () => {
    const pool = makeMockPool();
    const conn = pool._conn;
    conn.execute
      .mockResolvedValueOnce([[{ name: 'Clap', filename: 'src.mp4' }], []])
      .mockResolvedValueOnce([{ insertId: 7 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(addVideoToLibrary(3, 5, 'lib.mp4')).resolves.toEqual({
      status: 'added', libraryId: 7, sourceFilename: 'src.mp4',
    });
    expect(conn.execute.mock.calls[0]![0]).toContain('FOR SHARE');
    expect(conn.execute.mock.calls[0]![1]).toEqual([3, 5]);
    expect(conn.execute.mock.calls[1]![1]).toEqual(['Clap', 'lib.mp4', 5, 3]);
    expect(conn.commit).toHaveBeenCalled();
  });

  it('returns not_owner for someone else\'s (or a missing) video, without inserting', async () => {
    const pool = makeMockPool();
    pool._conn.execute.mockResolvedValueOnce([[], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(addVideoToLibrary(3, 6, 'lib.mp4')).resolves.toEqual({ status: 'not_owner' });
    expect(pool._conn.execute).toHaveBeenCalledTimes(1);
  });

  it('returns already_in_library when the video was added before', async () => {
    const pool = makeMockPool();
    pool._conn.execute
      .mockResolvedValueOnce([[{ name: 'Clap', filename: 'src.mp4' }], []])
      .mockRejectedValueOnce(duplicateEntryError('3', 'uq_overlay_video_library_source'))
      .mockResolvedValueOnce([[{ id: 2 }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(addVideoToLibrary(3, 5, 'lib.mp4')).resolves.toEqual({ status: 'already_in_library' });
    const [sql, params] = pool._conn.execute.mock.calls[2]!;
    expect(sql).toContain('WHERE source_video_id = ? FOR SHARE');
    expect(params).toEqual([3]);
  });

  it('rethrows a duplicate on the filename index, which is a caller bug', async () => {
    const pool = makeMockPool();
    pool._conn.execute
      .mockResolvedValueOnce([[{ name: 'Clap', filename: 'src.mp4' }], []])
      .mockRejectedValueOnce(duplicateEntryError('lib.mp4', 'uq_overlay_video_library_filename'))
      .mockResolvedValueOnce([[], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(addVideoToLibrary(3, 5, 'lib.mp4')).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    expect(pool._conn.rollback).toHaveBeenCalled();
  });

  it('rethrows a filename collision even when the filename contains the source key name', async () => {
    const pool = makeMockPool();
    const filename = 'uq_overlay_video_library_source.mp4';
    pool._conn.execute
      .mockResolvedValueOnce([[{ name: 'Clap', filename: 'src.mp4' }], []])
      .mockRejectedValueOnce(duplicateEntryError(filename, 'uq_overlay_video_library_filename'))
      .mockResolvedValueOnce([[], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(addVideoToLibrary(3, 5, filename)).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it('rethrows other errors and rolls back', async () => {
    const pool = makeMockPool();
    pool._conn.execute
      .mockResolvedValueOnce([[{ name: 'Clap', filename: 'src.mp4' }], []])
      .mockRejectedValueOnce(new Error('boom'));
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(addVideoToLibrary(3, 5, 'lib.mp4')).rejects.toThrow('boom');
    expect(pool._conn.rollback).toHaveBeenCalled();
    expect(pool._conn.release).toHaveBeenCalled();
  });
});

// ─── getLibraryVideos ────────────────────────────────────────────────────────

describe('getLibraryVideos', () => {
  it('maps entries newest first, with a null contributor when the streamer row is gone', async () => {
    const now = new Date();
    const rows = [
      { id: 2, name: 'B', filename: 'b.mp4', contributor_streamer_id: 5, source_video_id: 9, created_at: now, contributor_login: 'alice' },
      { id: 1, name: 'A', filename: 'a.mp4', contributor_streamer_id: null, source_video_id: null, created_at: now, contributor_login: null },
    ];
    const pool = makeMockPool({ rows });
    vi.mocked(getPool).mockReturnValue(pool as any);

    const result = await getLibraryVideos();
    expect(result).toEqual([
      { id: 2, name: 'B', filename: 'b.mp4', contributor_streamer_id: 5, contributor_login: 'alice', source_video_id: 9, created_at: now },
      { id: 1, name: 'A', filename: 'a.mp4', contributor_streamer_id: null, contributor_login: null, source_video_id: null, created_at: now },
    ]);
    const sql = pool.execute.mock.calls[0]![0] as string;
    expect(sql).toContain('LEFT JOIN streamer');
    expect(sql).toContain('ORDER BY l.created_at DESC');
  });
});

// ─── getImportedLibraryEntryIds ──────────────────────────────────────────────

describe('getLibraryVideoFilename', () => {
  it('returns the filename of the entry with that id', async () => {
    const pool = makeMockPool({ rows: [{ filename: 'lib.webm' }] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(getLibraryVideoFilename(4)).resolves.toBe('lib.webm');
    expect(pool.execute.mock.calls[0]![0]).toContain('FROM overlay_video_library WHERE id = ?');
    expect(pool.execute.mock.calls[0]![1]).toEqual([4]);
  });

  it('returns null when no entry has that id', async () => {
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows: [] }) as any);
    await expect(getLibraryVideoFilename(4)).resolves.toBeNull();
  });
});

describe('getImportedLibraryEntryIds', () => {
  it('returns the given streamer\'s imported entry ids only', async () => {
    const pool = makeMockPool({ rows: [{ library_entry_id: 4 }, { library_entry_id: 8 }] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(getImportedLibraryEntryIds(5)).resolves.toEqual([4, 8]);
    expect(pool.execute.mock.calls[0]![0]).toContain('WHERE streamer_id = ?');
    expect(pool.execute.mock.calls[0]![1]).toEqual([5]);
  });
});

// ─── importLibraryVideo ──────────────────────────────────────────────────────

describe('importLibraryVideo', () => {
  it('inserts the streamer\'s own copy with library_entry_id set and returns its id', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1, insertId: 31 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(importLibraryVideo(4, 5, 'copy.mp4')).resolves.toBe(31);
    const [sql, params] = pool.execute.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO overlay_video (streamer_id, name, filename, library_entry_id)');
    expect(params).toEqual([5, 'copy.mp4', 4]);
  });

  it('returns null when the entry no longer exists', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 0, insertId: 0 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(importLibraryVideo(4, 5, 'copy.mp4')).resolves.toBeNull();
  });
});

// ─── removeLibraryVideo ──────────────────────────────────────────────────────

describe('removeLibraryVideo', () => {
  it('deletes the entry and returns its filename', async () => {
    const pool = makeMockPool();
    pool._conn.execute
      .mockResolvedValueOnce([[{ filename: 'lib.mp4' }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(removeLibraryVideo(4)).resolves.toBe('lib.mp4');
    expect(pool._conn.execute.mock.calls[1]).toEqual(['DELETE FROM overlay_video_library WHERE id = ?', [4]]);
    expect(pool._conn.commit).toHaveBeenCalled();
  });

  it('returns null when no such entry exists', async () => {
    const pool = makeMockPool();
    pool._conn.execute.mockResolvedValueOnce([[], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(removeLibraryVideo(4)).resolves.toBeNull();
    expect(pool._conn.execute).toHaveBeenCalledTimes(1);
    expect(pool._conn.rollback).toHaveBeenCalled();
  });
});
