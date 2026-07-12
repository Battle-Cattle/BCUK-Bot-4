import { describe, it, expect, vi, beforeEach } from 'vitest';

// `withTransaction` is reimplemented here (rather than via `importOriginal`) so this
// test doesn't pull in pool.ts's real `../shared/config` import chain, which throws
// in a test environment with no DISCORD_TOKEN etc. set. The logic mirrors pool.ts's
// real implementation exactly, driven by the same mocked `getPool()`.
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
vi.mock('./sfxCache', () => ({
  invalidateSfxLookupCache: vi.fn(),
}));

import { getPool } from './pool';
import {
  findTrigger, findSoundFiles, getPublicSfxTriggers, getAllSfxTriggers,
  getAllCategories, createCategory, renameCategory, deleteCategory,
  createSfxTrigger, updateSfxTrigger, deleteSfxTrigger,
  addSfxFile, updateSfxFile, deleteSfxFile,
} from './sfx';
import { invalidateSfxLookupCache } from './sfxCache';
import { makeMockPool } from '../test-utils/mockMysqlPool';

/** Pool whose top-level execute returns row data (for SELECT queries). */
function makePool(rows: unknown[] = []) {
  return makeMockPool({ rows });
}

/** Pool whose top-level execute returns a ResultSetHeader (for INSERT/UPDATE/DELETE). */
function makeResultPool(result: unknown = { insertId: 0, affectedRows: 1 }) {
  return makeMockPool({ executeResult: [result, []] });
}

/** Pool exposing a transaction connection whose execute resolves queued results in order. */
function makeTxPool() {
  return makeMockPool();
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── findTrigger ─────────────────────────────────────────────────────────────

describe('findTrigger', () => {
  it('returns null when no rows found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const result = await findTrigger('!bang');
    expect(result).toBeNull();
  });

  it('maps a row with numeric hidden=1 to true', async () => {
    const row = { id: '1', trigger_command: '!bang', category_id: null, hidden: 1, description: null };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await findTrigger('!bang');
    expect(result).not.toBeNull();
    expect(result!.hidden).toBe(true);
  });

  it('maps a row with numeric hidden=0 to false', async () => {
    const row = { id: '2', trigger_command: '!clap', category_id: 3, hidden: 0, description: 'Clap sound' };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await findTrigger('!clap');
    expect(result!.hidden).toBe(false);
    expect(result!.description).toBe('Clap sound');
    expect(result!.category_id).toBe(3);
  });

  it('maps a row with Buffer hidden=0x01 to true', async () => {
    const row = { id: '3', trigger_command: '!wow', category_id: null, hidden: Buffer.from([1]), description: null };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await findTrigger('!wow');
    expect(result!.hidden).toBe(true);
  });

  it('maps a row with Buffer hidden=0x00 to false', async () => {
    const row = { id: '4', trigger_command: '!ok', category_id: null, hidden: Buffer.from([0]), description: null };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await findTrigger('!ok');
    expect(result!.hidden).toBe(false);
  });

  it('converts id to BigInt', async () => {
    const row = { id: '9007199254740993', trigger_command: '!big', category_id: null, hidden: 0, description: null };
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const result = await findTrigger('!big');
    expect(result!.id).toBe(9007199254740993n);
  });

  it('lowercases the command string before querying', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await findTrigger('!BANG');
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params[0]).toBe('!bang');
  });
});

// ─── findSoundFiles ───────────────────────────────────────────────────────────

describe('findSoundFiles', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const result = await findSoundFiles(1n);
    expect(result).toEqual([]);
  });

  it('maps rows correctly including Buffer hidden flag', async () => {
    const rows = [
      { id: 10, trigger_id: '1', file: 'bang.mp3', trigger_command: '!bang', weight: 2, hidden: Buffer.from([0]), category_id: null },
      { id: 11, trigger_id: '1', file: 'bang2.mp3', trigger_command: '!bang', weight: 1, hidden: 1, category_id: 3 },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await findSoundFiles(1n);
    expect(result).toHaveLength(2);
    expect(result[0].file).toBe('bang.mp3');
    expect(result[0].hidden).toBe(false);
    expect(result[0].trigger_id).toBe(1n);
    expect(result[1].hidden).toBe(true);
    expect(result[1].category_id).toBe(3);
  });

  it('passes triggerId as string to the query', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await findSoundFiles(42n);
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params[0]).toBe('42');
  });
});

// ─── getPublicSfxTriggers ─────────────────────────────────────────────────────

describe('getPublicSfxTriggers', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const result = await getPublicSfxTriggers();
    expect(result).toEqual([]);
  });

  it('maps rows with null categoryName and description', async () => {
    const rows = [{ triggerCommand: '!test', categoryName: null, description: null }];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getPublicSfxTriggers();
    expect(result[0]).toEqual({ triggerCommand: '!test', categoryName: null, description: null });
  });

  it('maps rows with categoryName and description', async () => {
    const rows = [{ triggerCommand: '!clap', categoryName: 'Reactions', description: 'Clap sound' }];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getPublicSfxTriggers();
    expect(result[0]).toEqual({ triggerCommand: '!clap', categoryName: 'Reactions', description: 'Clap sound' });
  });
});

// ─── getAllSfxTriggers ────────────────────────────────────────────────────────

describe('getAllSfxTriggers', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    const result = await getAllSfxTriggers();
    expect(result).toEqual([]);
  });

  it('groups multiple sound files under the same trigger', async () => {
    const rows = [
      { triggerId: '1', triggerCommand: '!bang', description: null, triggerHidden: 0, categoryName: null, sfxId: 10, file: 'a.mp3', weight: 1, sfxHidden: 0 },
      { triggerId: '1', triggerCommand: '!bang', description: null, triggerHidden: 0, categoryName: null, sfxId: 11, file: 'b.mp3', weight: 2, sfxHidden: 1 },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getAllSfxTriggers();
    expect(result).toHaveLength(1);
    expect(result[0].files).toHaveLength(2);
    expect(result[0].files[0].file).toBe('a.mp3');
    expect(result[0].files[1].hidden).toBe(true);
  });

  it('handles multiple distinct triggers', async () => {
    const rows = [
      { triggerId: '1', triggerCommand: '!bang', description: null, triggerHidden: 0, categoryName: null, sfxId: 10, file: 'a.mp3', weight: 1, sfxHidden: 0 },
      { triggerId: '2', triggerCommand: '!clap', description: 'Clap', triggerHidden: 1, categoryName: 'Reactions', sfxId: 20, file: 'c.mp3', weight: 3, sfxHidden: 0 },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getAllSfxTriggers();
    expect(result).toHaveLength(2);
    expect(result[1].triggerCommand).toBe('!clap');
    expect(result[1].hidden).toBe(true);
    expect(result[1].categoryName).toBe('Reactions');
  });

  it('skips adding to files array when sfxId is null (trigger with no files)', async () => {
    const rows = [
      { triggerId: '1', triggerCommand: '!silent', description: null, triggerHidden: 0, categoryName: null, sfxId: null, file: null, weight: null, sfxHidden: null },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getAllSfxTriggers();
    expect(result).toHaveLength(1);
    expect(result[0].files).toHaveLength(0);
  });

  it('maps triggerHidden as Buffer correctly', async () => {
    const rows = [
      { triggerId: '1', triggerCommand: '!test', description: null, triggerHidden: Buffer.from([1]), categoryId: null, categoryName: null, sfxId: null, file: null, weight: null, sfxHidden: null },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getAllSfxTriggers();
    expect(result[0].hidden).toBe(true);
  });

  it('exposes categoryId for edit-form preselection', async () => {
    const rows = [
      { triggerId: '1', triggerCommand: '!clap', description: null, triggerHidden: 0, categoryId: 7, categoryName: 'Reactions', sfxId: null, file: null, weight: null, sfxHidden: null },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getAllSfxTriggers();
    expect(result[0].categoryId).toBe(7);
  });
});

// ─── Categories ───────────────────────────────────────────────────────────────

describe('categories', () => {
  it('getAllCategories maps id and name', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([{ id: 1, name: 'Reactions' }, { id: 2, name: 'Alerts' }]) as any);
    const result = await getAllCategories();
    expect(result).toEqual([{ id: 1, name: 'Reactions' }, { id: 2, name: 'Alerts' }]);
  });

  it('createCategory inserts and returns the new id', async () => {
    const pool = makeResultPool({ insertId: 9 });
    vi.mocked(getPool).mockReturnValue(pool as any);
    const id = await createCategory('Memes');
    expect(id).toBe(9);
    expect(pool.execute.mock.calls[0][1]).toEqual(['Memes']);
  });

  it('renameCategory passes name then id and returns true when a row matched', async () => {
    const pool = makeResultPool({ affectedRows: 1 });
    vi.mocked(getPool).mockReturnValue(pool as any);
    const ok = await renameCategory(3, 'Renamed');
    expect(ok).toBe(true);
    expect(pool.execute.mock.calls[0][1]).toEqual(['Renamed', 3]);
  });

  it('renameCategory returns false when no row matched and the id does not exist', async () => {
    const pool = { execute: vi.fn() };
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]) // UPDATE
      .mockResolvedValueOnce([[], []]); // fallback SELECT — id not found
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await renameCategory(999, 'Nope')).toBe(false);
  });

  it('renameCategory returns true on a no-op update (name unchanged) when the row exists', async () => {
    const pool = { execute: vi.fn() };
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]) // UPDATE — no-op, name unchanged
      .mockResolvedValueOnce([[{ id: 3 }], []]); // fallback SELECT — id exists
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await renameCategory(3, 'Same')).toBe(true);
  });

  it('deleteCategory passes the id and returns true when a row matched', async () => {
    const pool = makeResultPool({ affectedRows: 1 });
    vi.mocked(getPool).mockReturnValue(pool as any);
    const ok = await deleteCategory(4);
    expect(ok).toBe(true);
    expect(pool.execute.mock.calls[0][1]).toEqual([4]);
  });

  it('deleteCategory returns false when no row matched', async () => {
    const pool = makeResultPool({ affectedRows: 0 });
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await deleteCategory(999)).toBe(false);
  });
});

// ─── Triggers (writes) ────────────────────────────────────────────────────────

describe('createSfxTrigger', () => {
  it('inserts with hidden coerced to 1/0 and returns BigInt id', async () => {
    const pool = makeResultPool({ insertId: 42 });
    vi.mocked(getPool).mockReturnValue(pool as any);
    const id = await createSfxTrigger('!clap', 3, 'Clap', true);
    expect(id).toBe(42n);
    expect(pool.execute.mock.calls[0][1]).toEqual(['!clap', 3, 'Clap', 1]);
  });

  it('passes null category/description and hidden=0', async () => {
    const pool = makeResultPool({ insertId: 1 });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await createSfxTrigger('!bang', null, null, false);
    expect(pool.execute.mock.calls[0][1]).toEqual(['!bang', null, null, 0]);
  });

  it('calls invalidateSfxLookupCache on success', async () => {
    const pool = makeResultPool({ insertId: 1 });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await createSfxTrigger('!bang', null, null, false);
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });
});

describe('updateSfxTrigger', () => {
  it('passes fields with id stringified last and returns true when a row matched', async () => {
    const pool = makeResultPool({ affectedRows: 1 });
    vi.mocked(getPool).mockReturnValue(pool as any);
    const ok = await updateSfxTrigger(5n, '!clap', 2, 'desc', false);
    expect(ok).toBe(true);
    expect(pool.execute.mock.calls[0][1]).toEqual(['!clap', 2, 'desc', 0, '5']);
  });

  it('returns false when no row matched (stale id)', async () => {
    const pool = { execute: vi.fn() };
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]) // UPDATE
      .mockResolvedValueOnce([[], []]); // fallback SELECT — id not found
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await updateSfxTrigger(999n, '!clap', null, null, false)).toBe(false);
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });

  it('returns true on a no-op update (all fields unchanged) when the row exists', async () => {
    const pool = { execute: vi.fn() };
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]) // UPDATE — no-op
      .mockResolvedValueOnce([[{ id: '5' }], []]); // fallback SELECT — id exists
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await updateSfxTrigger(5n, '!clap', 2, 'desc', false)).toBe(true);
  });

  it('calls invalidateSfxLookupCache when a row matched', async () => {
    const pool = makeResultPool({ affectedRows: 1 });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await updateSfxTrigger(5n, '!clap', 2, 'desc', false);
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });
});

describe('deleteSfxTrigger', () => {
  it('locks the trigger row, returns its files and deletes within a transaction', async () => {
    const pool = makeTxPool();
    pool._conn.execute
      .mockResolvedValueOnce([[{ id: '7' }], []]) // SELECT id FOR UPDATE
      .mockResolvedValueOnce([[{ file: 'a.mp3' }, { file: 'b.mp3' }], []]) // SELECT files FOR UPDATE
      .mockResolvedValueOnce([{ affectedRows: 2 }, []]) // DELETE sfx
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]); // DELETE trigger
    vi.mocked(getPool).mockReturnValue(pool as any);

    const result = await deleteSfxTrigger(7n);
    expect(result).toEqual({ files: ['a.mp3', 'b.mp3'] });
    // Both reads must lock their rows — the trigger first, then its child sound files —
    // so a concurrent addSfxFile/deleteSfxFile can't change the set after the snapshot.
    expect(pool._conn.execute.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(pool._conn.execute.mock.calls[1][0]).toContain('FOR UPDATE');
    expect(pool._conn.commit).toHaveBeenCalled();
    expect(pool._conn.release).toHaveBeenCalled();
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });

  it('rolls back and returns null when the trigger row does not exist', async () => {
    const pool = makeTxPool();
    pool._conn.execute.mockResolvedValueOnce([[], []]); // SELECT id FOR UPDATE — missing row
    vi.mocked(getPool).mockReturnValue(pool as any);

    const result = await deleteSfxTrigger(7n);
    expect(result).toBeNull();
    expect(pool._conn.rollback).toHaveBeenCalled();
    expect(pool._conn.commit).not.toHaveBeenCalled();
    expect(pool._conn.release).toHaveBeenCalled();
    // No child queries should run once the lock finds no trigger.
    expect(pool._conn.execute).toHaveBeenCalledTimes(1);
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });

  it('rolls back and rethrows on error', async () => {
    const pool = makeTxPool();
    pool._conn.execute.mockRejectedValueOnce(new Error('boom'));
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(deleteSfxTrigger(7n)).rejects.toThrow('boom');
    expect(pool._conn.rollback).toHaveBeenCalled();
    expect(pool._conn.release).toHaveBeenCalled();
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });
});

// ─── Sound files (writes) ─────────────────────────────────────────────────────

describe('addSfxFile', () => {
  it('inserts with triggerId stringified and returns the new id', async () => {
    const pool = makeResultPool({ insertId: 100 });
    vi.mocked(getPool).mockReturnValue(pool as any);
    const id = await addSfxFile(7n, 'clap.mp3', 2, false);
    expect(id).toBe(100);
    expect(pool.execute.mock.calls[0][1]).toEqual(['7', 'clap.mp3', 2, 0]);
  });

  it('calls invalidateSfxLookupCache on success', async () => {
    const pool = makeResultPool({ insertId: 100 });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await addSfxFile(7n, 'clap.mp3', 2, false);
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });
});

describe('updateSfxFile', () => {
  it('passes weight, hidden and id and returns true when a row matched', async () => {
    const pool = makeResultPool({ affectedRows: 1 });
    vi.mocked(getPool).mockReturnValue(pool as any);
    const ok = await updateSfxFile(11, 3, true);
    expect(ok).toBe(true);
    expect(pool.execute.mock.calls[0][1]).toEqual([3, 1, 11]);
  });

  it('returns false when no row matched (stale id)', async () => {
    const pool = { execute: vi.fn() };
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]) // UPDATE
      .mockResolvedValueOnce([[], []]); // fallback SELECT — id not found
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await updateSfxFile(999, 3, true)).toBe(false);
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });

  it('returns true on a no-op update (weight/hidden unchanged) when the row exists', async () => {
    const pool = { execute: vi.fn() };
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]) // UPDATE — no-op
      .mockResolvedValueOnce([[{ id: 11 }], []]); // fallback SELECT — id exists
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await updateSfxFile(11, 3, true)).toBe(true);
  });

  it('calls invalidateSfxLookupCache when a row matched', async () => {
    const pool = makeResultPool({ affectedRows: 1 });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await updateSfxFile(11, 3, true);
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });
});

describe('deleteSfxFile', () => {
  it('returns the file path and deletes the row', async () => {
    const pool = makeTxPool();
    pool._conn.execute
      .mockResolvedValueOnce([[{ file: 'clap.mp3' }], []]) // SELECT
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]); // DELETE
    vi.mocked(getPool).mockReturnValue(pool as any);

    const file = await deleteSfxFile(11);
    expect(file).toBe('clap.mp3');
    expect(pool._conn.commit).toHaveBeenCalled();
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });

  it('returns null and rolls back when no row exists', async () => {
    const pool = makeTxPool();
    pool._conn.execute.mockResolvedValueOnce([[], []]); // SELECT empty
    vi.mocked(getPool).mockReturnValue(pool as any);

    const file = await deleteSfxFile(999);
    expect(file).toBeNull();
    expect(pool._conn.rollback).toHaveBeenCalled();
    expect(pool._conn.commit).not.toHaveBeenCalled();
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });

  it('returns null and rolls back when the row is deleted concurrently between the locked SELECT and DELETE', async () => {
    const pool = makeTxPool();
    pool._conn.execute
      .mockResolvedValueOnce([[{ file: 'clap.mp3' }], []]) // SELECT FOR UPDATE — row still present
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]); // DELETE — already removed by a concurrent transaction
    vi.mocked(getPool).mockReturnValue(pool as any);

    const file = await deleteSfxFile(11);
    expect(file).toBeNull();
    expect(pool._conn.rollback).toHaveBeenCalled();
    expect(pool._conn.commit).not.toHaveBeenCalled();
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });

  it('rolls back, releases and rethrows on error', async () => {
    const pool = makeTxPool();
    pool._conn.execute.mockRejectedValueOnce(new Error('boom'));
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(deleteSfxFile(11)).rejects.toThrow('boom');
    expect(pool._conn.rollback).toHaveBeenCalled();
    expect(pool._conn.release).toHaveBeenCalled();
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });
});
