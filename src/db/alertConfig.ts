import mysql from 'mysql2/promise';
import { getPool, withTransaction } from './pool';
import { fromBit } from './utils';

/** Twitch event types the alerts overlay can react to. */
export type AlertEventType = 'follow' | 'sub' | 'resub' | 'giftsub' | 'raid';

/** All alert event types, in the fixed display order used by the settings page. */
export const ALERT_EVENT_TYPES: readonly AlertEventType[] = ['follow', 'sub', 'resub', 'giftsub', 'raid'];

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
    `SELECT id, streamer_id, event_type, enabled, message_template, image_filename, sound_filename, duration_ms
     FROM alert_config
     WHERE streamer_id = ?`,
    [streamerId],
  );
  return rows.map(mapRow);
}

/**
 * Fetches a single event type's alert configuration for a streamer, used at event-fire time.
 * @param streamerId DB row ID of the owning streamer.
 * @param eventType The alert event type to look up.
 * @returns The alert config, or null if no row exists for this streamer/event type.
 */
export async function getAlertConfig(streamerId: number, eventType: AlertEventType): Promise<AlertConfig | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, streamer_id, event_type, enabled, message_template, image_filename, sound_filename, duration_ms
     FROM alert_config
     WHERE streamer_id = ? AND event_type = ?`,
    [streamerId, eventType],
  );
  return rows.length === 0 ? null : mapRow(rows[0]);
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
}

/**
 * Upserts the non-file fields (enable flag, message template, display duration) of a
 * streamer's alert config for one event type. Image/sound filenames are managed separately
 * via {@link setAlertImage}/{@link setAlertSound} and are left untouched by this call.
 * @param streamerId DB row ID of the streamer.
 * @param eventType The alert event type being configured.
 * @param config The fields to persist.
 */
export async function saveAlertConfig(
  streamerId: number,
  eventType: AlertEventType,
  config: { enabled: boolean; message_template: string; duration_ms: number },
): Promise<void> {
  await getPool().execute(
    `INSERT INTO alert_config (streamer_id, event_type, enabled, message_template, duration_ms)
     VALUES (?, ?, ?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       enabled=new_row.enabled, message_template=new_row.message_template, duration_ms=new_row.duration_ms`,
    [streamerId, eventType, config.enabled ? 1 : 0, config.message_template, config.duration_ms],
  );
}

/**
 * Sets (or clears, when `filename` is null) the image asset for a streamer's alert config row,
 * returning the previous filename so the caller can remove the now-orphaned file on disk.
 * A no-op (returns null) if no matching row exists — the row is expected to already exist via
 * {@link initAlertConfigs}.
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
  return withTransaction(async (conn) => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT image_filename FROM alert_config WHERE streamer_id = ? AND event_type = ?`,
      [streamerId, eventType],
    );
    if (rows.length === 0) return null;
    const previous: string | null = rows[0].image_filename ?? null;
    await conn.execute(
      `UPDATE alert_config SET image_filename = ? WHERE streamer_id = ? AND event_type = ?`,
      [filename, streamerId, eventType],
    );
    return previous;
  });
}

/**
 * Sets (or clears, when `filename` is null) the sound asset for a streamer's alert config row,
 * returning the previous filename so the caller can remove the now-orphaned file on disk.
 * A no-op (returns null) if no matching row exists — the row is expected to already exist via
 * {@link initAlertConfigs}.
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
  return withTransaction(async (conn) => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT sound_filename FROM alert_config WHERE streamer_id = ? AND event_type = ?`,
      [streamerId, eventType],
    );
    if (rows.length === 0) return null;
    const previous: string | null = rows[0].sound_filename ?? null;
    await conn.execute(
      `UPDATE alert_config SET sound_filename = ? WHERE streamer_id = ? AND event_type = ?`,
      [filename, streamerId, eventType],
    );
    return previous;
  });
}
