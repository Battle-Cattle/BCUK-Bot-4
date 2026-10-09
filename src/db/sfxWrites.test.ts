import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./sfx', () => ({
  createCategory: vi.fn(),
  renameCategory: vi.fn(),
  deleteCategory: vi.fn(),
  createSfxTrigger: vi.fn(),
  updateSfxTrigger: vi.fn(),
  deleteSfxTrigger: vi.fn(),
  addSfxFile: vi.fn(),
  updateSfxFile: vi.fn(),
  deleteSfxFile: vi.fn(),
}));
vi.mock('./sfxCache', () => ({ invalidateSfxLookupCache: vi.fn() }));

import {
  createSfxTrigger as createSfxTriggerRecord,
  updateSfxTrigger as updateSfxTriggerRecord,
  deleteSfxTrigger as deleteSfxTriggerRecord,
  addSfxFile as addSfxFileRecord,
  updateSfxFile as updateSfxFileRecord,
  deleteSfxFile as deleteSfxFileRecord,
  createCategory as createCategoryRecord,
  renameCategory as renameCategoryRecord,
  deleteCategory as deleteCategoryRecord,
} from './sfx';
import { invalidateSfxLookupCache } from './sfxCache';
import {
  createCategory, renameCategory, deleteCategory, createSfxTrigger, updateSfxTrigger, deleteSfxTrigger,
  addSfxFile, updateSfxFile, deleteSfxFile,
} from './sfxWrites';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createSfxTriggerRecord).mockResolvedValue(1n);
  vi.mocked(updateSfxTriggerRecord).mockResolvedValue(true);
  vi.mocked(deleteSfxTriggerRecord).mockResolvedValue({ files: [] });
  vi.mocked(addSfxFileRecord).mockResolvedValue(1);
  vi.mocked(updateSfxFileRecord).mockResolvedValue(true);
  vi.mocked(deleteSfxFileRecord).mockResolvedValue('file.mp3');
  vi.mocked(createCategoryRecord).mockResolvedValue(1);
  vi.mocked(renameCategoryRecord).mockResolvedValue(true);
  vi.mocked(deleteCategoryRecord).mockResolvedValue(true);
});

// ─── SFX write wrappers ─────────────────────────────────────────────────────────
//
// sfx.ts is a pure DB layer with no cache knowledge; these tests verify these
// wrappers invalidate the SFX lookup cache after each write — unconditionally for
// createSfxTrigger/addSfxFile, and only when the record function reports a match
// for updateSfxTrigger/deleteSfxTrigger/updateSfxFile/deleteSfxFile.

describe('createCategory', () => {
  it('calls the record function, returns its id, and invalidates the cache', async () => {
    vi.mocked(createCategoryRecord).mockResolvedValue(9);
    const id = await createCategory('Reactions');
    expect(id).toBe(9);
    expect(createCategoryRecord).toHaveBeenCalledWith('Reactions');
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });
});

describe('renameCategory', () => {
  it('invalidates the cache when the record function reports a match', async () => {
    vi.mocked(renameCategoryRecord).mockResolvedValue(true);
    const result = await renameCategory(3, 'Memes');
    expect(result).toBe(true);
    expect(renameCategoryRecord).toHaveBeenCalledWith(3, 'Memes');
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });

  it('does NOT invalidate the cache when no category matched', async () => {
    vi.mocked(renameCategoryRecord).mockResolvedValue(false);
    const result = await renameCategory(999, 'Memes');
    expect(result).toBe(false);
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });
});

describe('deleteCategory', () => {
  it('invalidates the cache when a category was deleted', async () => {
    vi.mocked(deleteCategoryRecord).mockResolvedValue(true);
    const result = await deleteCategory(3);
    expect(result).toBe(true);
    expect(deleteCategoryRecord).toHaveBeenCalledWith(3);
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });

  it('does NOT invalidate the cache when no category existed', async () => {
    vi.mocked(deleteCategoryRecord).mockResolvedValue(false);
    const result = await deleteCategory(999);
    expect(result).toBe(false);
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });
});

describe('createSfxTrigger', () => {
  it('calls the record function, returns its id, and invalidates the cache', async () => {
    vi.mocked(createSfxTriggerRecord).mockResolvedValue(42n);
    const id = await createSfxTrigger('!clap', 3, 'Clap', true);
    expect(id).toBe(42n);
    expect(createSfxTriggerRecord).toHaveBeenCalledWith('!clap', 3, 'Clap', true);
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });
});

describe('updateSfxTrigger', () => {
  it('invalidates the cache when the record function reports a match', async () => {
    vi.mocked(updateSfxTriggerRecord).mockResolvedValue(true);
    const result = await updateSfxTrigger(5n, '!clap', 2, 'desc', false);
    expect(result).toBe(true);
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });

  it('does NOT invalidate the cache when no row matched', async () => {
    vi.mocked(updateSfxTriggerRecord).mockResolvedValue(false);
    const result = await updateSfxTrigger(999n, '!clap', null, null, false);
    expect(result).toBe(false);
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });
});

describe('deleteSfxTrigger', () => {
  it('invalidates the cache when a trigger was deleted', async () => {
    vi.mocked(deleteSfxTriggerRecord).mockResolvedValue({ files: ['a.mp3'] });
    const result = await deleteSfxTrigger(7n);
    expect(result).toEqual({ files: ['a.mp3'] });
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });

  it('does NOT invalidate the cache when no trigger existed', async () => {
    vi.mocked(deleteSfxTriggerRecord).mockResolvedValue(null);
    const result = await deleteSfxTrigger(999n);
    expect(result).toBeNull();
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });
});

describe('addSfxFile', () => {
  it('calls the record function, returns its id, and invalidates the cache', async () => {
    vi.mocked(addSfxFileRecord).mockResolvedValue(100);
    const id = await addSfxFile(7n, 'clap.mp3', 2, false);
    expect(id).toBe(100);
    expect(addSfxFileRecord).toHaveBeenCalledWith(7n, 'clap.mp3', 2, false);
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });
});

describe('updateSfxFile', () => {
  it('invalidates the cache when the record function reports a match', async () => {
    vi.mocked(updateSfxFileRecord).mockResolvedValue(true);
    const result = await updateSfxFile(11, 3, true);
    expect(result).toBe(true);
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });

  it('does NOT invalidate the cache when no row matched', async () => {
    vi.mocked(updateSfxFileRecord).mockResolvedValue(false);
    const result = await updateSfxFile(999, 3, true);
    expect(result).toBe(false);
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });
});

describe('deleteSfxFile', () => {
  it('invalidates the cache when a file was deleted', async () => {
    vi.mocked(deleteSfxFileRecord).mockResolvedValue('clap.mp3');
    const result = await deleteSfxFile(11);
    expect(result).toBe('clap.mp3');
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });

  it('does NOT invalidate the cache when no file existed', async () => {
    vi.mocked(deleteSfxFileRecord).mockResolvedValue(null);
    const result = await deleteSfxFile(999);
    expect(result).toBeNull();
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });
});
