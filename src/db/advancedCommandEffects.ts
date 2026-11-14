// Advanced command effects — companion parameters, overlay videos and the alert — for the
// commands in `advancedCommands.ts`: loading them onto commands, replacing them, and setting the
// alert's uploaded assets. Pure DB layer like that module; every write checks the command belongs
// to the streamer.
import mysql, { type PoolConnection } from 'mysql2/promise';
import { getPool, withTransactionOrNotFound } from './pool';
import { buildInClausePlaceholders } from './utils';
import type { TextAnimation } from './alertConfig';
import {
  normalizeAdvancedCommandEffects,
  type AdvancedCommandAlert,
  type AdvancedCommandAlertInput,
  type AdvancedCommandEffectsInput,
  type AdvancedCommandParam,
} from './advancedCommandValidation';

/** A weighted overlay video assigned to an advanced command, with its file details. */
export interface AdvancedCommandVideo {
  videoId: number;
  weight: number;
  name: string;
  filename: string;
}

/** The effects attached to an advanced command. */
export interface AdvancedCommandEffects {
  params: AdvancedCommandParam[];
  videos: AdvancedCommandVideo[];
  alert: AdvancedCommandAlert | null;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Maps a raw `advanced_command_alert` row to an {@link AdvancedCommandAlert}.
 * @param row - Row selected from `advanced_command_alert`.
 * @returns The mapped alert config.
 */
function mapAlert(row: mysql.RowDataPacket): AdvancedCommandAlert {
  return {
    messageTemplate: row.message_template,
    imageFilename: row.image_filename ?? null,
    soundFilename: row.sound_filename ?? null,
    durationMs: row.duration_ms,
    textAnimation: row.text_animation as TextAnimation,
  };
}

/**
 * Loads the params, videos and alert of `commands` (three queries, however many commands) and
 * attaches them in place.
 * @param commands - The commands to fill in; mutated.
 * @returns The same array, for chaining.
 */
export async function attachEffects<T extends { id: number } & AdvancedCommandEffects>(commands: T[]): Promise<T[]> {
  if (commands.length === 0) return commands;
  const byId = new Map(commands.map((c) => [c.id, c]));
  const ids = [...byId.keys()];
  const placeholders = buildInClausePlaceholders(ids.length);
  const pool = getPool();
  const [[paramRows], [videoRows], [alertRows]] = await Promise.all([
    pool.execute<mysql.RowDataPacket[]>(
      `SELECT command_id, param_key, param_value FROM advanced_command_param
       WHERE command_id IN (${placeholders}) ORDER BY param_key`, ids),
    pool.execute<mysql.RowDataPacket[]>(
      `SELECT cv.command_id, cv.video_id, cv.weight, v.name, v.filename
       FROM advanced_command_video cv JOIN overlay_video v ON v.id = cv.video_id
       WHERE cv.command_id IN (${placeholders}) ORDER BY v.name`, ids),
    pool.execute<mysql.RowDataPacket[]>(
      `SELECT command_id, message_template, image_filename, sound_filename, duration_ms, text_animation
       FROM advanced_command_alert WHERE command_id IN (${placeholders})`, ids),
  ]);
  for (const r of paramRows) byId.get(r.command_id)?.params.push({ key: r.param_key, value: r.param_value });
  for (const r of videoRows) {
    byId.get(r.command_id)?.videos.push({ videoId: r.video_id, weight: r.weight, name: r.name, filename: r.filename });
  }
  for (const r of alertRows) {
    const command = byId.get(r.command_id);
    if (command) command.alert = mapAlert(r);
  }
  return commands;
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Replaces a command's overlay videos, after checking every video belongs to the same streamer.
 * @param conn - The transaction connection.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param commandId - The command's id.
 * @param videos - The normalised video assignments.
 */
async function replaceVideos(
  conn: PoolConnection,
  streamerId: number,
  commandId: number,
  videos: AdvancedCommandEffectsInput['videos'],
): Promise<void> {
  await conn.execute('DELETE FROM advanced_command_video WHERE command_id = ?', [commandId]);
  if (videos.length === 0) return;
  const ids = videos.map((v) => v.videoId);
  const [owned] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT id FROM overlay_video WHERE streamer_id = ? AND id IN (${buildInClausePlaceholders(ids.length)})`,
    [streamerId, ...ids],
  );
  if (owned.length !== ids.length) throw new Error(`Video not owned by streamer ${streamerId}`);
  await conn.execute(
    `INSERT INTO advanced_command_video (command_id, video_id, weight) VALUES ${videos.map(() => '(?, ?, ?)').join(', ')}`,
    videos.flatMap((v) => [commandId, v.videoId, v.weight]),
  );
}

/**
 * Replaces a command's companion parameters.
 * @param conn - The transaction connection.
 * @param commandId - The command's id.
 * @param params - The normalised parameters.
 */
async function replaceParams(conn: PoolConnection, commandId: number, params: AdvancedCommandParam[]): Promise<void> {
  await conn.execute('DELETE FROM advanced_command_param WHERE command_id = ?', [commandId]);
  if (params.length === 0) return;
  await conn.execute(
    `INSERT INTO advanced_command_param (command_id, param_key, param_value) VALUES ${params.map(() => '(?, ?, ?)').join(', ')}`,
    params.flatMap((p) => [commandId, p.key, p.value]),
  );
}

/**
 * Replaces (or removes, when `alert` is null) a command's alert. Saving keeps the alert's
 * uploaded image and sound; removing it returns their filenames so the caller can delete them.
 * @param conn - The transaction connection.
 * @param commandId - The command's id.
 * @param alert - The normalised alert, or null for none.
 * @returns The filenames orphaned by removing the alert (empty when saving).
 */
async function replaceAlert(conn: PoolConnection, commandId: number, alert: AdvancedCommandAlertInput | null): Promise<string[]> {
  if (!alert) {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT image_filename, sound_filename FROM advanced_command_alert WHERE command_id = ?',
      [commandId],
    );
    await conn.execute('DELETE FROM advanced_command_alert WHERE command_id = ?', [commandId]);
    return assetFilenames(rows);
  }
  await conn.execute(
    `INSERT INTO advanced_command_alert (command_id, message_template, duration_ms, text_animation)
     VALUES (?, ?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE message_template = new_row.message_template,
       duration_ms = new_row.duration_ms, text_animation = new_row.text_animation`,
    [commandId, alert.messageTemplate, alert.durationMs, alert.textAnimation],
  );
  return [];
}

/**
 * Collects the non-null `image_filename`/`sound_filename` values from alert rows.
 * @param rows - Rows from `advanced_command_alert` with `image_filename`/`sound_filename` columns.
 * @returns The non-empty filenames, image then sound per row.
 */
export function assetFilenames(rows: mysql.RowDataPacket[]): string[] {
  return rows.flatMap((r) => [r.image_filename, r.sound_filename]).filter((f): f is string => typeof f === 'string' && f !== '');
}

/**
 * Replaces a command's effects — companion parameters, overlay videos and alert — in one
 * transaction, so a bad video id (one the streamer doesn't own) leaves the old effects in place.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param commandId - The command's id.
 * @param effects - The new effects; validated and normalised here.
 * @returns The alert asset filenames orphaned by removing the alert (for the caller to delete
 *   from disk), or null if the command doesn't exist for this streamer.
 * @throws `AdvancedCommandValidationError` on invalid effects.
 */
export async function saveAdvancedCommandEffects(
  streamerId: number,
  commandId: number,
  effects: AdvancedCommandEffectsInput,
): Promise<string[] | null> {
  const normalized = normalizeAdvancedCommandEffects(effects);
  return withTransactionOrNotFound(async (conn, notFound) => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT id FROM advanced_command WHERE id = ? AND streamer_id = ? FOR UPDATE',
      [commandId, streamerId],
    );
    if (rows.length === 0) return notFound();
    await replaceParams(conn, commandId, normalized.params);
    await replaceVideos(conn, streamerId, commandId, normalized.videos);
    return replaceAlert(conn, commandId, normalized.alert);
  });
}

/**
 * Sets (or clears, with null) the uploaded image or sound of a command's alert. The command must
 * belong to the streamer and already have an alert.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param commandId - The command's id.
 * @param kind - `'image'` or `'sound'`.
 * @param filename - The new stored filename, or null to clear it.
 * @returns `{ previous }` — the replaced filename (null if none) for the caller to delete — or
 *   null if the command or its alert doesn't exist for this streamer.
 */
export async function setAdvancedCommandAlertAsset(
  streamerId: number,
  commandId: number,
  kind: 'image' | 'sound',
  filename: string | null,
): Promise<{ previous: string | null } | null> {
  const column = kind === 'image' ? 'image_filename' : 'sound_filename';
  return withTransactionOrNotFound(async (conn, notFound) => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT a.${column} AS filename FROM advanced_command_alert a
       JOIN advanced_command ac ON ac.id = a.command_id
       WHERE a.command_id = ? AND ac.streamer_id = ? FOR UPDATE`,
      [commandId, streamerId],
    );
    const row = rows[0];
    if (!row) return notFound();
    await conn.execute(`UPDATE advanced_command_alert SET ${column} = ? WHERE command_id = ?`, [filename, commandId]);
    return { previous: (row.filename as string | null) ?? null };
  });
}
