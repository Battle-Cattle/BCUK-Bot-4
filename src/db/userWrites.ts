// Cache-invalidating wrappers for users.ts writes, re-exported by the db.ts facade —
// users.ts is a pure DB layer with no cache knowledge.
import { upsertUserRecord, setTwitchBotEnabledRecord, deleteUnlinkedUserRecord } from './users';
import { invalidateCustomCommandLookupCache } from './customCommandCache';
import { invalidateAdvancedCommandLookupCache } from './advancedCommandCache';
import { withInvalidation } from './withInvalidation';

/**
 * Invalidates every lookup cache keyed by a user's Twitch channel: custom commands (assigned per
 * channel) and advanced commands (routed by their streamer's channel).
 */
function invalidateTwitchChannelCaches(): void {
  invalidateCustomCommandLookupCache();
  invalidateAdvancedCommandLookupCache();
}

/**
 * Upserts a user record and invalidates the custom- and advanced-command lookup caches when
 * the `twitchName` field is provided (including explicit null to clear it).
 * @param discordId - Discord snowflake as a string.
 * @param discordName - Display name to store; blank after trimming is stored as null.
 * @param accessLevel - Legacy global access level; must be one of `AccessLevel`'s values.
 * @param twitchName - Twitch channel name to set, or null to clear it; omit to leave unchanged.
 * @returns Resolves once the upsert (and any cache invalidation) completes.
 */
export async function upsertUser(
  discordId: string,
  discordName: string,
  accessLevel: number,
  twitchName?: string | null,
): Promise<void> {
  const twitchNameProvided = await upsertUserRecord(discordId, discordName, accessLevel, twitchName);
  if (twitchNameProvided) {
    invalidateTwitchChannelCaches();
  }
}

/**
 * Sets whether a user's Twitch bot integration is enabled and invalidates the
 * custom- and advanced-command lookup caches.
 * @param discordId - Discord snowflake as a string.
 * @param enabled - True to enable the Twitch bot for this user, false to disable it.
 * @returns Resolves once the update (and cache invalidation) completes.
 */
export async function updateTwitchBotEnabled(discordId: string, enabled: boolean): Promise<void> {
  await withInvalidation(() => setTwitchBotEnabledRecord(discordId, enabled), invalidateTwitchChannelCaches);
}

/**
 * Deletes a user row that nothing else references — no guild membership, streamer record,
 * command/timer assignment or tokens (see `deleteUnlinkedUserRecord`) — and invalidates the
 * custom- and advanced-command lookup caches.
 * @param discordId - Discord snowflake as a string.
 * @returns True if the row was deleted; false if it didn't exist or is still referenced.
 */
export async function deleteUnlinkedUser(discordId: string): Promise<boolean> {
  return withInvalidation(() => deleteUnlinkedUserRecord(discordId), invalidateTwitchChannelCaches);
}
