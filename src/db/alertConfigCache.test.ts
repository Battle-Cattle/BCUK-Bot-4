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
vi.mock('./alertConfig', () => ({
  getAllAlertConfigs: vi.fn(),
}));

import { findCachedAlertConfig, invalidateAlertConfigLookupCache } from './alertConfigCache';
import { createManagedLookupCache } from './lookupCache';
import { getAllAlertConfigs } from './alertConfig';
import type { AlertConfig } from './alertConfig';

// alertConfigCache.ts calls createManagedLookupCache exactly once at module load, before any
// `vi.clearAllMocks()` in beforeEach can wipe its call history — so the mocked cache manager
// instance (and its `invalidate` spy) must be captured here, once, up front.
const mockedCacheManager = vi.mocked(createManagedLookupCache).mock.results[0]?.value as
  | { invalidate: ReturnType<typeof vi.fn> }
  | undefined;

function makeAlertConfig(overrides: Partial<AlertConfig> = {}): AlertConfig {
  return {
    id: 1,
    streamer_id: 42,
    event_type: 'follow',
    enabled: true,
    message_template: 'hi',
    image_filename: null,
    sound_filename: null,
    duration_ms: 6000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllAlertConfigs).mockResolvedValue([]);
});

describe('findCachedAlertConfig', () => {
  it('returns null when no row matches the streamer/event-type pair', async () => {
    vi.mocked(getAllAlertConfigs).mockResolvedValue([makeAlertConfig({ streamer_id: 1, event_type: 'follow' })]);

    const result = await findCachedAlertConfig(1, 'raid');

    expect(result).toBeNull();
  });

  it('finds the row matching both streamer_id and event_type', async () => {
    const row = makeAlertConfig({ streamer_id: 42, event_type: 'raid', message_template: 'raid msg' });
    vi.mocked(getAllAlertConfigs).mockResolvedValue([row]);

    const result = await findCachedAlertConfig(42, 'raid');

    expect(result).toEqual(row);
  });

  it('does not confuse rows with the same event_type but a different streamer_id', async () => {
    vi.mocked(getAllAlertConfigs).mockResolvedValue([
      makeAlertConfig({ streamer_id: 1, event_type: 'follow', message_template: 'streamer 1' }),
      makeAlertConfig({ streamer_id: 2, event_type: 'follow', message_template: 'streamer 2' }),
    ]);

    const result = await findCachedAlertConfig(2, 'follow');

    expect(result?.message_template).toBe('streamer 2');
  });

  it('returns null for any lookup when there are no rows at all', async () => {
    vi.mocked(getAllAlertConfigs).mockResolvedValue([]);

    const result = await findCachedAlertConfig(1, 'follow');

    expect(result).toBeNull();
  });
});

describe('invalidateAlertConfigLookupCache', () => {
  it('delegates to the underlying cache manager\'s invalidate', () => {
    invalidateAlertConfigLookupCache();
    expect(mockedCacheManager?.invalidate).toHaveBeenCalledOnce();
  });
});
