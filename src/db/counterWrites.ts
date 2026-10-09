// Cache-invalidating wrappers for counters.ts/counterArchive.ts writes, re-exported by the db.ts
// facade. counters.ts is a pure DB layer with no cache knowledge (breaks its import cycle with
// counterCache.ts), so the invalidation lives here instead.
import {
  addCounter as addCounterRecord,
  updateCounter as updateCounterRecord,
  removeCounter as removeCounterRecord,
  resetCounterCurrentValue as resetCounterCurrentValueRecord,
  incrementCounter as incrementCounterRecord,
} from './counters';
import { archiveAndResetYearlyCounters as archiveAndResetYearlyCountersRecord } from './counterArchive';
import type { UpdateCounterInput, CounterFieldsInput } from './counters';
import { invalidateCounterLookupCache } from './counterCache';
import { withInvalidation } from './withInvalidation';

/**
 * Creates a new counter and invalidates the counter lookup cache.
 * @param guildId - The guild this counter belongs to.
 * @param input - The counter's initial fields.
 * @returns Resolves once the insert (and cache invalidation) completes.
 */
export async function addCounter(guildId: string, input: CounterFieldsInput): Promise<void> {
  await withInvalidation(
    () => addCounterRecord(guildId, input),
    invalidateCounterLookupCache,
  );
}

/**
 * Updates an existing counter's fields and invalidates the counter lookup cache.
 * @param guildId - The guild the counter must belong to.
 * @param input - The counter's id and updated fields.
 * @returns Resolves once the update (and cache invalidation) completes.
 */
export async function updateCounter(guildId: string, input: UpdateCounterInput): Promise<void> {
  await withInvalidation(() => updateCounterRecord(guildId, input), invalidateCounterLookupCache);
}

/**
 * Deletes a counter by id and invalidates the counter lookup cache.
 * @param guildId - The guild the counter must belong to.
 * @param id - The counter's numeric id.
 * @returns Resolves once the deletion (and cache invalidation) completes.
 */
export async function removeCounter(guildId: string, id: number): Promise<void> {
  await withInvalidation(() => removeCounterRecord(guildId, id), invalidateCounterLookupCache);
}

/**
 * Resets a counter's current value to 0 and invalidates the counter lookup cache.
 * @param guildId - The guild the counter must belong to.
 * @param id - The counter's numeric id.
 * @returns Resolves once the update (and cache invalidation) completes.
 */
export async function resetCounterCurrentValue(guildId: string, id: number): Promise<void> {
  await withInvalidation(() => resetCounterCurrentValueRecord(guildId, id), invalidateCounterLookupCache);
}

/**
 * Atomically increments a counter's current value and invalidates the counter lookup cache.
 * @param id - The counter's numeric id.
 * @returns The counter's current value after the increment.
 */
export async function incrementCounter(id: number): Promise<number> {
  return withInvalidation(() => incrementCounterRecord(id), invalidateCounterLookupCache);
}

/**
 * Archives and resets every yearly-reset counter for the given year, and invalidates the
 * counter lookup cache.
 * @param year - Calendar year to archive into.
 * @returns The number of counters archived and reset.
 */
export async function archiveAndResetYearlyCounters(year: number): Promise<number> {
  return withInvalidation(() => archiveAndResetYearlyCountersRecord(year), invalidateCounterLookupCache);
}
