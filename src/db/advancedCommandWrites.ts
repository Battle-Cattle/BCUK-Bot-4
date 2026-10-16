// Cache-invalidating wrappers for advancedCommands.ts writes, re-exported by the db.ts facade —
// advancedCommands.ts is a pure DB layer with no cache knowledge (same pattern as
// customCommandWrites.ts).
import {
  addAdvancedCommand as addRecord,
  updateAdvancedCommand as updateRecord,
  setAdvancedCommandEnabled as setEnabledRecord,
  removeAdvancedCommand as removeRecord,
} from './advancedCommands';
import type { AdvancedCommandSettings } from './advancedCommandValidation';
import { invalidateAdvancedCommandLookupCache } from './advancedCommandCache';
import { withInvalidation } from './withInvalidation';

/**
 * Creates an advanced command and invalidates the chat lookup cache.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param settings - The command's settings.
 * @returns The new command's id.
 */
export async function addAdvancedCommand(streamerId: number, settings: AdvancedCommandSettings): Promise<number> {
  return withInvalidation(() => addRecord(streamerId, settings), invalidateAdvancedCommandLookupCache);
}

/**
 * Replaces an advanced command's settings and invalidates the chat lookup cache.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param commandId - The command's id.
 * @param settings - The new settings.
 * @returns True if the command existed for this streamer.
 */
export async function updateAdvancedCommand(
  streamerId: number,
  commandId: number,
  settings: AdvancedCommandSettings,
): Promise<boolean> {
  return withInvalidation(() => updateRecord(streamerId, commandId, settings), invalidateAdvancedCommandLookupCache);
}

/**
 * Enables, disables or toggles an advanced command and invalidates the chat lookup cache.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param commandId - The command's id.
 * @param enabled - The new state, or undefined to toggle.
 * @returns The new state, or null if the command doesn't exist for this streamer.
 */
export async function setAdvancedCommandEnabled(
  streamerId: number,
  commandId: number,
  enabled?: boolean,
): Promise<boolean | null> {
  return withInvalidation(() => setEnabledRecord(streamerId, commandId, enabled), invalidateAdvancedCommandLookupCache);
}

/**
 * Deletes an advanced command and invalidates the chat lookup cache.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param commandId - The command's id.
 * @returns The command's alert asset filenames to delete, or null if nothing was deleted.
 */
export async function removeAdvancedCommand(streamerId: number, commandId: number): Promise<string[] | null> {
  return withInvalidation(() => removeRecord(streamerId, commandId), invalidateAdvancedCommandLookupCache);
}
