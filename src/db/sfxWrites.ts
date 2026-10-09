// Cache-invalidating wrappers for sfx.ts writes, re-exported by the db.ts facade. sfx.ts is a
// pure DB layer with no cache knowledge (breaks its import cycle with sfxCache.ts), so the
// invalidation lives here instead.
import {
  createSfxTrigger as createSfxTriggerRecord,
  updateSfxTrigger as updateSfxTriggerRecord,
  deleteSfxTrigger as deleteSfxTriggerRecord,
  addSfxFile as addSfxFileRecord,
  updateSfxFile as updateSfxFileRecord,
  deleteSfxFile as deleteSfxFileRecord,
  createCategory as createCategoryRecord,
  renameCategory as renameCategoryRecord,
  deleteCategory as deleteCategoryRecord,
} from './sfx';
import { invalidateSfxLookupCache } from './sfxCache';
import { withInvalidation } from './withInvalidation';

/**
 * Creates a new SFX category and invalidates the SFX lookup cache.
 * @param name - Category name.
 * @returns The new category id.
 */
export async function createCategory(name: string): Promise<number> {
  return withInvalidation(() => createCategoryRecord(name), invalidateSfxLookupCache);
}

/**
 * Renames an SFX category and invalidates the SFX lookup cache if it existed.
 * @param id - Category id.
 * @param name - New category name.
 * @returns true if the category exists, false if no category with that id existed.
 */
export async function renameCategory(id: number, name: string): Promise<boolean> {
  const renamed = await renameCategoryRecord(id, name);
  if (renamed) invalidateSfxLookupCache();
  return renamed;
}

/**
 * Deletes an SFX category and invalidates the SFX lookup cache if it existed. Triggers/sounds
 * referencing it keep working — the FK is ON DELETE SET NULL, so their category_id becomes
 * NULL (uncategorised), which is why the cache (which snapshots category_id) must be invalidated.
 * @param id - Category id.
 * @returns true if the category existed, false otherwise.
 */
export async function deleteCategory(id: number): Promise<boolean> {
  const deleted = await deleteCategoryRecord(id);
  if (deleted) invalidateSfxLookupCache();
  return deleted;
}

/**
 * Creates a new SFX trigger and invalidates the SFX lookup cache.
 * @param command - Full prefixed command string, e.g. `!clap`.
 * @param categoryId - Category id, or null for uncategorised.
 * @param description - Optional public description, or null.
 * @param hidden - Whether the trigger is hidden from the public listing.
 * @returns The new trigger id.
 */
export async function createSfxTrigger(
  command: string, categoryId: number | null, description: string | null, hidden: boolean,
): Promise<bigint> {
  return withInvalidation(
    () => createSfxTriggerRecord(command, categoryId, description, hidden),
    invalidateSfxLookupCache,
  );
}

/**
 * Updates an existing SFX trigger and invalidates the SFX lookup cache if it existed.
 * @param id - Trigger id.
 * @param command - Full prefixed command string, e.g. `!clap`.
 * @param categoryId - Category id, or null for uncategorised.
 * @param description - Optional public description, or null.
 * @param hidden - Whether the trigger is hidden from the public listing.
 * @returns true if the trigger exists, false if no trigger with that id existed.
 */
export async function updateSfxTrigger(
  id: bigint, command: string, categoryId: number | null, description: string | null, hidden: boolean,
): Promise<boolean> {
  const updated = await updateSfxTriggerRecord(id, command, categoryId, description, hidden);
  if (updated) invalidateSfxLookupCache();
  return updated;
}

/**
 * Deletes an SFX trigger and its sound files, invalidating the SFX lookup cache if it existed.
 * @param id - Trigger id.
 * @returns The relative paths of the deleted sound files, or null if no trigger with that id
 *   existed.
 */
export async function deleteSfxTrigger(id: bigint): Promise<{ files: string[] } | null> {
  const result = await deleteSfxTriggerRecord(id);
  if (result !== null) invalidateSfxLookupCache();
  return result;
}

/**
 * Adds a sound file to a trigger and invalidates the SFX lookup cache.
 * @param triggerId - Owning trigger id.
 * @param file - Relative path (within SFX_FOLDER) of the stored audio file.
 * @param weight - Weighted-random selection weight (>= 1).
 * @param hidden - Whether the file is hidden from the public listing.
 * @returns The new sfx row id.
 */
export async function addSfxFile(
  triggerId: bigint, file: string, weight: number, hidden: boolean,
): Promise<number> {
  return withInvalidation(() => addSfxFileRecord(triggerId, file, weight, hidden), invalidateSfxLookupCache);
}

/**
 * Updates a sound file's weight/hidden flag, invalidating the SFX lookup cache if it existed.
 * @param id - sfx row id.
 * @param weight - Weighted-random selection weight (>= 1).
 * @param hidden - Whether the file is hidden from the public listing.
 * @returns true if the sfx row exists, false if no sfx row with that id existed.
 */
export async function updateSfxFile(id: number, weight: number, hidden: boolean): Promise<boolean> {
  const updated = await updateSfxFileRecord(id, weight, hidden);
  if (updated) invalidateSfxLookupCache();
  return updated;
}

/**
 * Deletes a sound file row, invalidating the SFX lookup cache if it existed.
 * @param id - sfx row id.
 * @returns The deleted file's relative path, or null if no such row existed.
 */
export async function deleteSfxFile(id: number): Promise<string | null> {
  const file = await deleteSfxFileRecord(id);
  if (file !== null) invalidateSfxLookupCache();
  return file;
}
