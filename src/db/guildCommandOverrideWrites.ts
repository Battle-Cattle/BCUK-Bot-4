// Cache-invalidating wrappers for guildCommandOverrides.ts writes, re-exported by the db.ts facade.
// Overrides affect Discord command resolution, so each write invalidates the custom-command cache.
import {
  upsertOverride as upsertOverrideRecord,
  removeOverride as removeOverrideRecord,
} from './guildCommandOverrides';
import { invalidateCustomCommandLookupCache } from './customCommandCache';
import { withInvalidation } from './withInvalidation';

/**
 * Inserts or updates a guild's override for a catalog command and invalidates
 * the custom-command lookup cache, since overrides affect Discord command resolution.
 * @param guildId - BIGINT snowflake as a string.
 * @param commandId - The catalog command's command_id.
 * @param override.isDisabled - When true, the command does not fire in this guild.
 * @param override.output - Replacement Discord output, or null to use the catalog output.
 * @returns Resolves once the upsert (and cache invalidation) completes.
 */
export async function upsertOverride(
  guildId: string,
  commandId: number,
  override: { isDisabled: boolean; output: string | null },
): Promise<void> {
  await withInvalidation(() => upsertOverrideRecord(guildId, commandId, override), invalidateCustomCommandLookupCache);
}

/**
 * Removes a guild's override for a command and invalidates the custom-command
 * lookup cache. No-op if the override is absent.
 * @param guildId - BIGINT snowflake as a string.
 * @param commandId - The catalog command's command_id.
 * @returns Resolves once the deletion (and cache invalidation) completes.
 */
export async function removeOverride(guildId: string, commandId: number): Promise<void> {
  await withInvalidation(() => removeOverrideRecord(guildId, commandId), invalidateCustomCommandLookupCache);
}
