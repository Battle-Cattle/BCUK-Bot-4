// Cache-invalidating wrappers for alertConfig.ts writes, re-exported by the db.ts facade.
// alertConfig.ts is a pure DB layer with no cache knowledge (breaks its import cycle with
// alertConfigCache.ts), so the invalidation lives here instead.
import {
  initAlertConfigs as initAlertConfigsRecord,
  saveAlertConfig as saveAlertConfigRecord,
  setAlertImage as setAlertImageRecord,
  setAlertSound as setAlertSoundRecord,
} from './alertConfig';
import type { AlertEventType, TextAnimation } from './alertConfig';
import { invalidateAlertConfigLookupCache } from './alertConfigCache';
import { withInvalidation } from './withInvalidation';

/**
 * Inserts default (disabled) alert config rows for all event types for a streamer and
 * invalidates the alert config lookup cache.
 * @param streamerId - DB row ID of the streamer to initialise alert config for.
 * @returns Resolves once the insert (and cache invalidation) completes.
 */
export async function initAlertConfigs(streamerId: number): Promise<void> {
  await withInvalidation(() => initAlertConfigsRecord(streamerId), invalidateAlertConfigLookupCache);
}

/**
 * Upserts a streamer's alert config for one event type and invalidates the alert config
 * lookup cache.
 * @param streamerId - DB row ID of the streamer.
 * @param eventType - The alert event type being configured.
 * @param config - The fields to persist.
 * @returns Resolves once the upsert (and cache invalidation) completes.
 */
export async function saveAlertConfig(
  streamerId: number,
  eventType: AlertEventType,
  config: { enabled: boolean; message_template: string; duration_ms: number; text_animation: TextAnimation },
): Promise<void> {
  await withInvalidation(
    () => saveAlertConfigRecord(streamerId, eventType, config),
    invalidateAlertConfigLookupCache,
  );
}

/**
 * Sets (or clears) a streamer's alert image and invalidates the alert config lookup cache.
 * @param streamerId - DB row ID of the streamer.
 * @param eventType - The alert event type being configured.
 * @param filename - The new stored filename, or null to clear the image.
 * @returns The previous filename, or null if there was none.
 */
export async function setAlertImage(
  streamerId: number, eventType: AlertEventType, filename: string | null,
): Promise<string | null> {
  return withInvalidation(
    () => setAlertImageRecord(streamerId, eventType, filename),
    invalidateAlertConfigLookupCache,
  );
}

/**
 * Sets (or clears) a streamer's alert sound and invalidates the alert config lookup cache.
 * @param streamerId - DB row ID of the streamer.
 * @param eventType - The alert event type being configured.
 * @param filename - The new stored filename, or null to clear the sound.
 * @returns The previous filename, or null if there was none.
 */
export async function setAlertSound(
  streamerId: number, eventType: AlertEventType, filename: string | null,
): Promise<string | null> {
  return withInvalidation(
    () => setAlertSoundRecord(streamerId, eventType, filename),
    invalidateAlertConfigLookupCache,
  );
}
