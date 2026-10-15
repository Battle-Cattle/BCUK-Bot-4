// Cache-invalidating wrappers for loyaltyPointsExclusions.ts's writes, re-exported by the db.ts
// facade. loyaltyPointsExclusions.ts is a pure DB layer with no cache knowledge, so the
// invalidation lives here instead — same pattern as loyaltyPointsWrites.ts.
import { addExclusion, removeExclusion } from './loyaltyPointsExclusions';
import { invalidateLoyaltyPointsExclusionLookupCache } from './loyaltyPointsExclusionCache';
import { withInvalidation } from './withInvalidation';

/**
 * Excludes an account from a streamer's loyalty points and invalidates the exclusion cache.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The Twitch login to exclude.
 * @returns Resolves once the write (and cache invalidation) completes.
 */
export async function addLoyaltyPointsExclusion(streamerId: number, twitchUsername: string): Promise<void> {
  await withInvalidation(() => addExclusion(streamerId, twitchUsername), invalidateLoyaltyPointsExclusionLookupCache);
}

/**
 * Removes an account from a streamer's loyalty-points exclusion list and invalidates the
 * exclusion cache.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The Twitch login to un-exclude.
 * @returns Resolves once the write (and cache invalidation) completes.
 */
export async function removeLoyaltyPointsExclusion(streamerId: number, twitchUsername: string): Promise<void> {
  await withInvalidation(() => removeExclusion(streamerId, twitchUsername), invalidateLoyaltyPointsExclusionLookupCache);
}
