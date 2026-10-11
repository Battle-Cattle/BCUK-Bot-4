import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared across the mock factory (which vitest hoists above these imports) and the test bodies
// below, so `invalidateLoyaltyPointsConfigLookupCache` can be asserted against the same spy the
// mocked cache instance actually holds.
const { invalidateSpy } = vi.hoisted(() => ({ invalidateSpy: vi.fn() }));

vi.mock('./lookupCache', () => ({
  // Mirrors createManagedLookupCache's real shape closely enough to exercise
  // loyaltyPointsCache.ts's own createEmptyCache callback (real callers rely on it as the
  // pre-first-load fallback), not just loadCache.
  createManagedLookupCache: vi.fn((options: { createEmptyCache: () => unknown; loadCache: () => Promise<unknown> }) => {
    options.createEmptyCache();
    return {
      getCache: () => options.loadCache(),
      invalidate: invalidateSpy,
    };
  }),
  DEFAULT_CACHE_TTL_MS: 300_000,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS: 5_000,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS: 60_000,
}));
vi.mock('./loyaltyPoints', () => ({
  getAllConfigs: vi.fn(),
}));

import { getCachedConfig, invalidateLoyaltyPointsConfigLookupCache } from './loyaltyPointsCache';
import { getAllConfigs } from './loyaltyPoints';
import type { LoyaltyPointsConfig } from './loyaltyPoints';

function makeConfig(overrides: Partial<LoyaltyPointsConfig> = {}): LoyaltyPointsConfig {
  return { pointsPerMessage: 1, cooldownSeconds: 60, pointsPerSub: 100, pointsPerGiftSub: 100, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllConfigs).mockResolvedValue([]);
});

describe('getCachedConfig', () => {
  it('returns null when no streamer has a saved configuration', async () => {
    expect(await getCachedConfig(1)).toBeNull();
  });

  it('finds a streamer\'s configuration by id', async () => {
    const config = makeConfig({ pointsPerMessage: 3 });
    vi.mocked(getAllConfigs).mockResolvedValue([{ streamerId: 1, config }]);

    expect(await getCachedConfig(1)).toEqual(config);
  });

  it('returns null for a streamer id not present in the loaded set', async () => {
    vi.mocked(getAllConfigs).mockResolvedValue([{ streamerId: 1, config: makeConfig() }]);

    expect(await getCachedConfig(2)).toBeNull();
  });

  it('distinguishes between two streamers\' configurations', async () => {
    const configA = makeConfig({ pointsPerMessage: 1 });
    const configB = makeConfig({ pointsPerMessage: 5 });
    vi.mocked(getAllConfigs).mockResolvedValue([{ streamerId: 1, config: configA }, { streamerId: 2, config: configB }]);

    expect(await getCachedConfig(1)).toEqual(configA);
    expect(await getCachedConfig(2)).toEqual(configB);
  });
});

describe('invalidateLoyaltyPointsConfigLookupCache', () => {
  it('invalidates the underlying lookup cache', () => {
    invalidateLoyaltyPointsConfigLookupCache();
    expect(invalidateSpy).toHaveBeenCalledOnce();
  });
});
