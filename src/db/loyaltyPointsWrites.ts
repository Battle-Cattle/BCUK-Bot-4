// Cache-invalidating wrapper for loyaltyPoints.ts's setConfig write, re-exported by the db.ts
// facade. loyaltyPoints.ts is a pure DB layer with no cache knowledge (breaks its import cycle
// with loyaltyPointsCache.ts), so the invalidation lives here instead — same pattern as
// counterWrites.ts/counterCache.ts.
import { setConfig as setConfigRecord, type LoyaltyPointsConfig } from './loyaltyPoints';
import { invalidateLoyaltyPointsConfigLookupCache } from './loyaltyPointsCache';
import { withInvalidation } from './withInvalidation';

/**
 * Creates or replaces a streamer's loyalty-points earn-rate configuration and invalidates the
 * loyalty-points config lookup cache.
 * @param streamerId - The streamer's `streamer.id`.
 * @param config - The new configuration.
 * @returns Resolves once the write (and cache invalidation) completes.
 */
export async function setLoyaltyPointsConfig(streamerId: number, config: LoyaltyPointsConfig): Promise<void> {
  await withInvalidation(() => setConfigRecord(streamerId, config), invalidateLoyaltyPointsConfigLookupCache);
}
