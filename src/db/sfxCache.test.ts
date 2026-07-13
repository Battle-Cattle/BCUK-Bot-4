import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./lookupCache', () => ({
  createManagedLookupCache: vi.fn(({ loadCache }: { loadCache: () => Promise<unknown> }) => ({
    getCache: () => loadCache(),
    invalidate: vi.fn(),
  })),
  DEFAULT_CACHE_TTL_MS: 300_000,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS: 5_000,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS: 60_000,
}));
vi.mock('./sfx', () => ({
  getAllSfxTriggers: vi.fn(),
}));
vi.mock('../shared/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { findCachedSfxTrigger, invalidateSfxLookupCache } from './sfxCache';
import { createManagedLookupCache } from './lookupCache';
import { getAllSfxTriggers } from './sfx';
import type { SfxTriggerRow } from './sfx';

// sfxCache.ts calls createManagedLookupCache exactly once at module load, before any
// `vi.clearAllMocks()` in beforeEach can wipe its call history — so the mocked cache
// manager instance (and its `invalidate` spy) must be captured here, once, up front.
const mockedCacheManager = vi.mocked(createManagedLookupCache).mock.results[0]?.value as
  | { invalidate: ReturnType<typeof vi.fn> }
  | undefined;

function makeTriggerRow(triggerId: string, triggerCommand: string, files: SfxTriggerRow['files'] = []): SfxTriggerRow {
  return {
    triggerId,
    triggerCommand,
    description: null,
    hidden: false,
    categoryId: null,
    categoryName: null,
    files,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllSfxTriggers).mockResolvedValue([]);
});

describe('findCachedSfxTrigger', () => {
  it('returns null for an empty string without making a DB call', async () => {
    const result = await findCachedSfxTrigger('');
    expect(result).toBeNull();
    expect(getAllSfxTriggers).not.toHaveBeenCalled();
  });

  it('returns null for a whitespace-only string without making a DB call', async () => {
    const result = await findCachedSfxTrigger('   ');
    expect(result).toBeNull();
    expect(getAllSfxTriggers).not.toHaveBeenCalled();
  });

  it('finds a trigger and its files by command', async () => {
    const row = makeTriggerRow('1', '!bang', [{ id: 10, file: 'bang.mp3', weight: 1, hidden: false }]);
    vi.mocked(getAllSfxTriggers).mockResolvedValue([row]);

    const result = await findCachedSfxTrigger('!bang');

    expect(result).not.toBeNull();
    expect(result!.trigger.id).toBe(1n);
    expect(result!.trigger.trigger_command).toBe('!bang');
    expect(result!.files).toHaveLength(1);
    expect(result!.files[0].file).toBe('bang.mp3');
    expect(result!.files[0].trigger_id).toBe(1n);
  });

  it('performs a case-insensitive lookup', async () => {
    const row = makeTriggerRow('1', '!bang');
    vi.mocked(getAllSfxTriggers).mockResolvedValue([row]);

    const result = await findCachedSfxTrigger('!BANG');

    expect(result).not.toBeNull();
    expect(result!.trigger.id).toBe(1n);
  });

  it('trims whitespace from the lookup string', async () => {
    const row = makeTriggerRow('1', '!bang');
    vi.mocked(getAllSfxTriggers).mockResolvedValue([row]);

    const result = await findCachedSfxTrigger('  !bang  ');

    expect(result).not.toBeNull();
  });

  it('returns null when no trigger matches the command', async () => {
    vi.mocked(getAllSfxTriggers).mockResolvedValue([makeTriggerRow('1', '!bang')]);

    const result = await findCachedSfxTrigger('!unknown');

    expect(result).toBeNull();
  });

  it('includes hidden triggers and hidden files — hidden only affects public listing, not playback', async () => {
    const row: SfxTriggerRow = {
      ...makeTriggerRow('1', '!secret', [{ id: 10, file: 'secret.mp3', weight: 1, hidden: true }]),
      hidden: true,
    };
    vi.mocked(getAllSfxTriggers).mockResolvedValue([row]);

    const result = await findCachedSfxTrigger('!secret');

    expect(result).not.toBeNull();
    expect(result!.trigger.hidden).toBe(true);
    expect(result!.files[0].hidden).toBe(true);
  });

  it('returns a copy — mutating the result does not affect subsequent lookups', async () => {
    const row = makeTriggerRow('1', '!bang', [{ id: 10, file: 'bang.mp3', weight: 1, hidden: false }]);
    vi.mocked(getAllSfxTriggers).mockResolvedValue([row]);

    const first = await findCachedSfxTrigger('!bang');
    expect(first).not.toBeNull();
    first!.files[0].weight = 999;

    const second = await findCachedSfxTrigger('!bang');
    expect(second).not.toBeNull();
    expect(second!.files).not.toBe(first!.files);
    expect(second!.files[0].weight).toBe(1);
  });

  it('collision — lower id wins when two triggers normalize to the same command', async () => {
    const winner = makeTriggerRow('1', '!bang');
    const loser = makeTriggerRow('2', '!BANG');
    vi.mocked(getAllSfxTriggers).mockResolvedValue([winner, loser]);

    const result = await findCachedSfxTrigger('!bang');

    expect(result).not.toBeNull();
    expect(result!.trigger.id).toBe(1n);
  });

  it('sorts by id before processing so lower id still wins even when given in reverse order', async () => {
    const loser = makeTriggerRow('2', '!bang');
    const winner = makeTriggerRow('1', '!bang');
    vi.mocked(getAllSfxTriggers).mockResolvedValue([loser, winner]);

    const result = await findCachedSfxTrigger('!bang');

    expect(result).not.toBeNull();
    expect(result!.trigger.id).toBe(1n);
  });

  it('returns null for any command when the trigger list is empty', async () => {
    vi.mocked(getAllSfxTriggers).mockResolvedValue([]);

    const result = await findCachedSfxTrigger('!anything');

    expect(result).toBeNull();
  });
});

describe('invalidateSfxLookupCache', () => {
  it('delegates to the underlying cache manager\'s invalidate', () => {
    invalidateSfxLookupCache();
    expect(mockedCacheManager?.invalidate).toHaveBeenCalledOnce();
  });
});
