// Cache-invalidating wrappers for customCommands.ts writes, re-exported by the db.ts facade.
// customCommands.ts is a pure DB layer with no cache knowledge (breaks its import cycle with
// customCommandCache.ts), so the invalidation lives here instead.
import { invalidateCustomCommandLookupCache } from './customCommandCache';
import {
  addCustomCommand as addCustomCommandRecord,
  updateCustomCommand as updateCustomCommandRecord,
  removeCustomCommand as removeCustomCommandRecord,
  updateOwnCustomCommand as updateOwnCustomCommandRecord,
  removeOwnCustomCommand as removeOwnCustomCommandRecord,
  discardOwnNewCustomCommand as discardOwnNewCustomCommandRecord,
  assignUserToCommand as assignUserToCommandRecord,
  assignUsersToCommand as assignUsersToCommandRecord,
  unassignUserFromCommand as unassignUserFromCommandRecord,
} from './customCommands';
import { withInvalidation } from './withInvalidation';

/**
 * Creates a new custom command and invalidates the custom-command lookup cache.
 * @param triggerString - Full prefixed command string (e.g. `!clap`).
 * @param output - Response text.
 * @param isDiscordEnabled - When true, the command responds in Discord.
 * @param isMultiTwitch - When true, the command can be assigned to multiple Twitch streamers.
 * @returns The auto-incremented `command_id` of the newly created row.
 */
export async function addCustomCommand(
  triggerString: string, output: string, isDiscordEnabled: boolean, isMultiTwitch: boolean,
): Promise<number> {
  return withInvalidation(
    () => addCustomCommandRecord(triggerString, output, isDiscordEnabled, isMultiTwitch),
    invalidateCustomCommandLookupCache,
  );
}

/**
 * Updates an existing custom command and invalidates the custom-command lookup cache.
 * @param commandId - ID of the command to update.
 * @param triggerString - New trigger string.
 * @param output - New response text.
 * @param isDiscordEnabled - Whether the command responds in Discord.
 * @param isMultiTwitch - Whether the command can be assigned to multiple Twitch streamers.
 * @returns Resolves once the update (and cache invalidation) completes.
 */
export async function updateCustomCommand(
  commandId: number, triggerString: string, output: string, isDiscordEnabled: boolean, isMultiTwitch: boolean,
): Promise<void> {
  return withInvalidation(
    () => updateCustomCommandRecord(commandId, triggerString, output, isDiscordEnabled, isMultiTwitch),
    invalidateCustomCommandLookupCache,
  );
}

/**
 * Deletes a custom command and invalidates the custom-command lookup cache.
 * @param commandId - ID of the command to delete.
 * @returns Resolves once the deletion (and cache invalidation) completes.
 */
export async function removeCustomCommand(commandId: number): Promise<void> {
  return withInvalidation(() => removeCustomCommandRecord(commandId), invalidateCustomCommandLookupCache);
}

/**
 * Streamer self-service update (Twitch-only, owner-checked under a lock) that invalidates the
 * custom-command lookup cache. A denied update throws before the cache is invalidated.
 * @param commandId - ID of the command to update.
 * @param triggerString - New trigger string.
 * @param output - New response text.
 * @param discordId - Discord ID of the streamer making the change.
 * @returns Resolves once the update (and cache invalidation) completes.
 */
export async function updateOwnCustomCommand(
  commandId: number, triggerString: string, output: string, discordId: string,
): Promise<void> {
  return withInvalidation(
    () => updateOwnCustomCommandRecord(commandId, triggerString, output, discordId),
    invalidateCustomCommandLookupCache,
  );
}

/**
 * Streamer self-service delete (owner-checked under a lock) that invalidates the custom-command
 * lookup cache. A denied delete throws before the cache is invalidated.
 * @param commandId - ID of the command to delete.
 * @param discordId - Discord ID of the streamer making the change.
 * @returns Resolves once the deletion (and cache invalidation) completes.
 */
export async function removeOwnCustomCommand(commandId: number, discordId: string): Promise<void> {
  return withInvalidation(() => removeOwnCustomCommandRecord(commandId, discordId), invalidateCustomCommandLookupCache);
}

/**
 * Cleans up a streamer's just-created command after a failed self-assignment, only while it is
 * still unclaimed (checked under a lock), and invalidates the custom-command lookup cache. A denied
 * cleanup throws before the cache is invalidated.
 * @param commandId - ID of the command to discard.
 * @param discordId - Discord ID of the streamer who created it.
 * @returns Resolves once the deletion (and cache invalidation) completes.
 */
export async function discardOwnNewCustomCommand(commandId: number, discordId: string): Promise<void> {
  return withInvalidation(() => discardOwnNewCustomCommandRecord(commandId, discordId), invalidateCustomCommandLookupCache);
}

/**
 * Assigns a Discord user to a custom command and invalidates the custom-command lookup cache.
 * @param commandId - ID of the command to assign the user to.
 * @param discordId - Discord snowflake of the user to assign.
 * @returns Resolves once the assignment (and cache invalidation) completes.
 */
export async function assignUserToCommand(commandId: number, discordId: string): Promise<void> {
  return withInvalidation(() => assignUserToCommandRecord(commandId, discordId), invalidateCustomCommandLookupCache);
}

/**
 * Assigns multiple Discord users to a custom command and invalidates the custom-command
 * lookup cache.
 * @param commandId - ID of the command to assign the users to.
 * @param discordIds - Discord snowflakes of the users to assign.
 * @returns Resolves once the assignment (and cache invalidation) completes.
 */
export async function assignUsersToCommand(commandId: number, discordIds: string[]): Promise<void> {
  return withInvalidation(() => assignUsersToCommandRecord(commandId, discordIds), invalidateCustomCommandLookupCache);
}

/**
 * Removes a Discord user's assignment from a custom command and invalidates the
 * custom-command lookup cache.
 * @param commandId - ID of the command to remove the assignment from.
 * @param discordId - Discord snowflake of the user to unassign.
 * @returns Resolves once the removal (and cache invalidation) completes.
 */
export async function unassignUserFromCommand(commandId: number, discordId: string): Promise<void> {
  return withInvalidation(
    () => unassignUserFromCommandRecord(commandId, discordId),
    invalidateCustomCommandLookupCache,
  );
}
