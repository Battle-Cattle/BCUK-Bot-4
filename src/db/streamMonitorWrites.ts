// Cache-invalidating wrappers for streamMonitor.ts's streamer-row inserts/deletes, re-exported by
// the db.ts facade. streamMonitor.ts is a pure DB layer with no cache knowledge, so the
// invalidation of the streamer-ID cache (streamerIdCache.ts) lives here instead — same pattern
// as counterWrites.ts.
import {
  addStreamer as addStreamerRecord,
  removeStreamer as removeStreamerRecord,
  removeStreamGroupAndStreamers as removeStreamGroupAndStreamersRecord,
} from './streamMonitor';
import { invalidateStreamerIdLookupCache } from './streamerIdCache';
import { withInvalidation } from './withInvalidation';

/**
 * Adds a streamer to a stream group and invalidates the streamer-ID cache.
 * @param discordId - Discord snowflake of the user to register as a streamer.
 * @param groupId - ID of the stream group to add the streamer to.
 * @param guildId - Guild the caller is acting in; `groupId` must belong to it.
 * @returns Resolves once the insert (and cache invalidation) completes; throws if `groupId` isn't in `guildId`.
 */
export async function addStreamer(discordId: string, groupId: number, guildId: string): Promise<void> {
  await withInvalidation(() => addStreamerRecord(discordId, groupId, guildId), invalidateStreamerIdLookupCache);
}

/**
 * Removes a streamer row and invalidates the streamer-ID cache.
 * @param id - Primary key of the streamer row to delete.
 * @param guildId - Guild the caller is acting in.
 * @returns True if a streamer was actually deleted; false if `id`'s group didn't belong to `guildId`.
 */
export async function removeStreamer(id: number, guildId: string): Promise<boolean> {
  return withInvalidation(() => removeStreamerRecord(id, guildId), invalidateStreamerIdLookupCache);
}

/**
 * Deletes a stream group with all of its streamers and invalidates the streamer-ID cache.
 * @param groupId - ID of the stream group to remove, along with its streamers.
 * @param guildId - Guild the caller is acting in; the group must belong to it.
 * @returns True if the group was actually deleted; false if it didn't belong to `guildId`.
 */
export async function removeStreamGroupAndStreamers(groupId: number, guildId: string): Promise<boolean> {
  return withInvalidation(() => removeStreamGroupAndStreamersRecord(groupId, guildId), invalidateStreamerIdLookupCache);
}
