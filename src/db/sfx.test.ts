import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import { findTrigger, findSoundFiles, getPublicSfxTriggers, getAllSfxTriggers } from './sfx';

function makePool(rows: unknown[] = []) {
  return { execute: vi.fn().mockResolvedValue([[...rows], []]) };
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
      { triggerId: '1', triggerCommand: '!test', description: null, triggerHidden: Buffer.from([1]), categoryName: null, sfxId: null, file: null, weight: null, sfxHidden: null },
    ];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const result = await getAllSfxTriggers();
    expect(result[0].hidden).toBe(true);
  });
});
