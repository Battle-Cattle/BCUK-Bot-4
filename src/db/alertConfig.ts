import mysql from 'mysql2/promise';
import { getPool, withTransaction } from './pool';
import { fromBit } from './utils';
// invalidateAlertConfigLookupCache lives in alertConfigCache.ts, which imports getAllAlertConfigs
// from this file for its read-side load. Both calls happen inside function bodies (never at
// module-eval time), so the cyclic import between the two files is safe — mirrors sfx.ts's own
// import of invalidateSfxLookupCache from sfxCache.ts.
import { invalidateAlertConfigLookupCache } from './alertConfigCache';

/** Twitch event types the alerts overlay can react to. */
export type AlertEventType = 'follow' | 'sub' | 'resub' | 'giftsub' | 'raid';

/** All alert event types, in the fixed display order used by the settings page. */
export const ALERT_EVENT_TYPES: readonly AlertEventType[] = ['follow', 'sub', 'resub', 'giftsub', 'raid'];

/** On-screen text animation styles the alerts overlay can apply to an alert's message. */
export type TextAnimation = 'none' | 'wave' | 'pulse' | 'glitch';

/** All text animation styles, in the fixed display order used by the settings page. */
export const ALERT_TEXT_ANIMATIONS: readonly TextAnimation[] = ['none', 'wave', 'pulse', 'glitch'];

/** A single streamer's alert configuration for one event type. */
export interface AlertConfig {
  id: number;
  streamer_id: number;
  event_type: AlertEventType;
  enabled: boolean;
  message_template: string;
  image_filename: string | null;
  sound_filename: string | null;
  duration_ms: number;
  text_animation: TextAnimation;
}

/** Default message templates seeded for a new streamer, mirroring the tone of `DEFAULT_EVENT_CONFIG` in `eventSub.ts`. */
const DEFAULT_MESSAGE_TEMPLATES: Record<AlertEventType, string> = {
  follow: 'Thanks {display_name} for the follow!',
  sub: 'Thanks {display_name} for subscribing! ({tier_name})',
  resub: 'Thanks {display_name} for {months} months! ({tier_name})',
  giftsub: '{gifter_display} gifted {count} sub(s) to the community!',
  raid: 'Welcome raiders from {from_display}! Thank you for the {viewers} person raid!',
};

/** Maps a raw `alert_config` row to an {@link AlertConfig}. */
function mapRow(r: mysql.RowDataPacket): AlertConfig {
  return {
    id: r.id,
    streamer_id: r.streamer_id,
    event_type: r.event_type,
    enabled: fromBit(r.enabled),
    message_template: r.message_template,
    image_filename: r.image_filename ?? null,
    sound_filename: r.sound_filename ?? null,
    duration_ms: r.duration_ms,
    text_animation: r.text_animation,
  };
}

/**
 * Fetches all alert configuration rows for a streamer (up to one per {@link AlertEventType}),
 * for use by the alerts settings page.
 * @param streamerId DB row ID of the owning streamer.
 * @returns The streamer's alert configs, in no particular order.
 */
export async function getAlertConfigsForStreamer(streamerId: number): Promise<AlertConfig[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, streamer_id, event_type, enabled, message_template, image_filename, sound_filename, duration_ms, text_animation
     FROM alert_config
     WHERE streamer_id = ?`,
    [streamerId],
  );
  return rows.map(mapRow);
}

/**
 * Fetches the set of enabled alert event types for each of the given streamers in a single
 * query, avoiding one round-trip per streamer — used by `loadStreamersForEventSub` to build
 * subscription-gating state for every streamer in one batch, the same way `getAllEventSubStreamers`
 * already bulk-fetches `streamer_event_config` via a JOIN.
 * @param streamerIds DB row IDs of the streamers to look up.
 * @returns Map of streamerId to the Set of its enabled alert event types. A streamer with no
 *   enabled alerts is omitted — callers should treat a missing key as an empty Set.
 */
export async function getEnabledAlertEventTypesBatch(streamerIds: number[]): Promise<Map<number, Set<AlertEventType>>> {
  const result = new Map<number, Set<AlertEventType>>();
  if (streamerIds.length === 0) return result;
  const placeholders = streamerIds.map(() => '?').join(', ');
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT streamer_id, event_type FROM alert_config WHERE enabled = 1 AND streamer_id IN (${placeholders})`,
    streamerIds,
  );
  for (const row of rows) {
    if (!result.has(row.streamer_id)) result.set(row.streamer_id, new Set());
    result.get(row.streamer_id)!.add(row.event_type);
  }
  return result;
}

/**
 * Fetches a single event type's alert configuration for a streamer, used at event-fire time.
 * @param streamerId DB row ID of the owning streamer.
 * @param eventType The alert event type to look up.
 * @returns The alert config, or null if no row exists for this streamer/event type.
 */
export async function getAlertConfig(streamerId: number, eventType: AlertEventType): Promise<AlertConfig | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, streamer_id, event_type, enabled, message_template, image_filename, sound_filename, duration_ms, text_animation
     FROM alert_config
     WHERE streamer_id = ? AND event_type = ?`,
    [streamerId, eventType],
  );
  return rows.length === 0 ? null : mapRow(rows[0]);
}

/**
 * Fetches every alert config row across all streamers, for the lookup cache's bulk refresh —
 * mirrors `getAllSfxTriggers`'s role for `sfxCache.ts`.
 * @returns Every `alert_config` row in the table, in no particular order.
 */
export async function getAllAlertConfigs(): Promise<AlertConfig[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, streamer_id, event_type, enabled, message_template, image_filename, sound_filename, duration_ms, text_animation
     FROM alert_config`,
  );
  return rows.map(mapRow);
}

/**
 * Inserts default (disabled) alert config rows for all event types for a streamer, if they
 * don't already exist. Uses INSERT IGNORE so it is safe to call multiple times without
 * overwriting existing config — mirrors `initEventConfig` in `eventSub.ts`.
 * @param streamerId DB row ID of the streamer to initialise alert config for.
 */
export async function initAlertConfigs(streamerId: number): Promise<void> {
  const placeholders = ALERT_EVENT_TYPES.map(() => '(?, ?, 0, ?)').join(', ');
  const params = ALERT_EVENT_TYPES.flatMap((eventType) => [streamerId, eventType, DEFAULT_MESSAGE_TEMPLATES[eventType]]);
  await getPool().execute(
    `INSERT IGNORE INTO alert_config (streamer_id, event_type, enabled, message_template)
     VALUES ${placeholders}`,
    params,
  );
  invalidateAlertConfigLookupCache();
}

/**
 * Upserts the non-file fields (enable flag, message template, display duration, text
 * animation) of a streamer's alert config for one event type. Image/sound filenames are
 * managed separately via {@link setAlertImage}/{@link setAlertSound} and are left untouched
 * by this call.
 * @param streamerId DB row ID of the streamer.
 * @param eventType The alert event type being configured.
 * @param config The fields to persist.
 */
export async function saveAlertConfig(
  streamerId: number,
  eventType: AlertEventType,
  config: { enabled: boolean; message_template: string; duration_ms: number; text_animation: TextAnimation },
): Promise<void> {
  await getPool().execute(
    `INSERT INTO alert_config (streamer_id, event_type, enabled, message_template, duration_ms, text_animation)
     VALUES (?, ?, ?, ?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       enabled=new_row.enabled, message_template=new_row.message_template, duration_ms=new_row.duration_ms,
       text_animation=new_row.text_animation`,
    [streamerId, eventType, config.enabled ? 1 : 0, config.message_template, config.duration_ms, config.text_animation],
  );
  invalidateAlertConfigLookupCache();
}

/**
 * Sets (or clears, when `filename` is null) one asset column of a streamer's alert config row,
 * returning the previous filename so the caller can remove the now-orphaned file on disk.
 * If no matching row exists yet — e.g. a streamer who hasn't (re-)completed the Twitch OAuth
 * flow that calls {@link initAlertConfigs} since this feature shipped — inserts a new row with
 * the default (disabled) settings for that event type rather than silently discarding the
 * asset, so an upload is never accepted without actually being persisted. Shared by
 * {@link setAlertImage} and {@link setAlertSound}, which differ only in which fixed, trusted
 * column name they target — never derived from user input.
 *
 * Locks the row with `SELECT … FOR UPDATE` before the snapshot (mirroring `deleteSfxFile`'s
 * rationale in `db/sfx.ts`), so two concurrent uploads/deletes for the same streamer/eventType
 * can't both read the same "previous" filename — which would otherwise let one request's newly
 * uploaded file be silently orphaned on disk (never recorded as "previous" by the other, and so
 * never cleaned up by either).
 * @param column The asset column to update (`image_filename` or `sound_filename`).
 * @param streamerId DB row ID of the streamer.
 * @param eventType The alert event type being configured.
 * @param filename The new stored filename, or null to clear the asset.
 * @returns The previous filename, or null if there was none (including when a new row had to
 *   be created).
 */
async function setAlertAssetColumn(
  column: 'image_filename' | 'sound_filename',
  streamerId: number,
  eventType: AlertEventType,
  filename: string | null,
): Promise<string | null> {
  const previous = await withTransaction(async (conn) => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT ${column} FROM alert_config WHERE streamer_id = ? AND event_type = ? FOR UPDATE`,
      [streamerId, eventType],
    );
    if (rows.length === 0) {
      await conn.execute(
        `INSERT INTO alert_config (streamer_id, event_type, enabled, message_template, ${column})
         VALUES (?, ?, 0, ?, ?)`,
        [streamerId, eventType, DEFAULT_MESSAGE_TEMPLATES[eventType], filename],
      );
      return null;
    }
    const previous: string | null = rows[0][column] ?? null;
    await conn.execute(
      `UPDATE alert_config SET ${column} = ? WHERE streamer_id = ? AND event_type = ?`,
      [filename, streamerId, eventType],
    );
    return previous;
  });
  invalidateAlertConfigLookupCache();
  return previous;
}

/**
 * Sets (or clears, when `filename` is null) the image asset for a streamer's alert config row.
 * See {@link setAlertAssetColumn} for the shared behaviour.
 * @param streamerId DB row ID of the streamer.
 * @param eventType The alert event type being configured.
 * @param filename The new stored filename, or null to clear the image.
 * @returns The previous filename, or null if there was none (or no matching row existed).
 */
export async function setAlertImage(
  streamerId: number,
  eventType: AlertEventType,
  filename: string | null,
): Promise<string | null> {
  return setAlertAssetColumn('image_filename', streamerId, eventType, filename);
}

/**
 * Sets (or clears, when `filename` is null) the sound asset for a streamer's alert config row.
 * See {@link setAlertAssetColumn} for the shared behaviour.
 * @param streamerId DB row ID of the streamer.
 * @param eventType The alert event type being configured.
 * @param filename The new stored filename, or null to clear the sound.
 * @returns The previous filename, or null if there was none (or no matching row existed).
 */
export async function setAlertSound(
  streamerId: number,
  eventType: AlertEventType,
  filename: string | null,
): Promise<string | null> {
  return setAlertAssetColumn('sound_filename', streamerId, eventType, filename);
}
