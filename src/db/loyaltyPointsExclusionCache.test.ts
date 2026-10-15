import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared across the mock factory (which vitest hoists above these imports) and the test bodies.
const { invalidateSpy } = vi.hoisted(() => ({ invalidateSpy: vi.fn() }));

vi.mock('./lookupCache', () => ({
  // Mirrors createManagedLookupCache's real shape closely enough to exercise both the
  // createEmptyCache and loadCache callbacks, as loyaltyPointsCache.test.ts does.
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
vi.mock('./loyaltyPointsExclusions', () => ({
  getAllExclusions: vi.fn(),
  normalizeExcludedUsername: (name: string) => name.trim().toLowerCase(),
}));

import { isExcludedFromLoyaltyPoints, invalidateLoyaltyPointsExclusionLookupCache } from './loyaltyPointsExclusionCache';
import { getAllExclusions } from './loyaltyPointsExclusions';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllExclusions).mockResolvedValue([
    { streamerId: 1, twitchUsername: 'pokemoncommunitygame' },
    { streamerId: 1, twitchUsername: 'bcuk_bot' },
    { streamerId: 2, twitchUsername: 'otherbot' },
  ]);
});

describe('isExcludedFromLoyaltyPoints', () => {
  it('is true for an account the streamer excluded', async () => {
    expect(await isExcludedFromLoyaltyPoints(1, 'pokemoncommunitygame')).toBe(true);
    expect(await isExcludedFromLoyaltyPoints(1, 'bcuk_bot')).toBe(true);
  });

  it('matches case-insensitively', async () => {
    expect(await isExcludedFromLoyaltyPoints(1, 'PokemonCommunityGame')).toBe(true);
  });

  it('is false for an account that is not excluded', async () => {
    expect(await isExcludedFromLoyaltyPoints(1, 'viewer')).toBe(false);
  });

  it('does not apply one streamer\'s exclusions to another', async () => {
    expect(await isExcludedFromLoyaltyPoints(2, 'pokemoncommunitygame')).toBe(false);
    expect(await isExcludedFromLoyaltyPoints(1, 'otherbot')).toBe(false);
  });

  it('is false for a streamer with no exclusions at all', async () => {
    expect(await isExcludedFromLoyaltyPoints(3, 'pokemoncommunitygame')).toBe(false);
  });
});

describe('invalidateLoyaltyPointsExclusionLookupCache', () => {
  it('invalidates the underlying lookup cache', () => {
    invalidateLoyaltyPointsExclusionLookupCache();
    expect(invalidateSpy).toHaveBeenCalledOnce();
  });
});
