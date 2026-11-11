import mysql from 'mysql2/promise';
import { getPool, withTransactionOrNotFound } from './pool';

/** One video in the shared overlay list. */
export interface SharedOverlayVideo {
  id: number;
  name: string;
  filename: string;
  /** Discord snowflake of the uploader; null once that user row is gone. */
  uploaded_by: string | null;
  enabled: boolean;
  created_at: Date;
}

/** A shared video with its uploader's Twitch login, for the admin list. */
export interface SharedOverlayVideoWithUploader extends SharedOverlayVideo {
  /** Twitch login of the uploader; null when unknown or they have none. */
  uploader_login: string | null;
}

/**
 * Maps a DB row to a {@link SharedOverlayVideo}.
 * @param r - Row from `shared_overlay_video`.
 * @returns The typed video.
 */
function toVideo(r: mysql.RowDataPacket): SharedOverlayVideo {
  return {
    id: r.id,
    name: r.name,
    filename: r.filename,
    uploaded_by: r.uploaded_by ?? null,
    enabled: Boolean(r.enabled),
    created_at: r.created_at,
  };
}

/**
 * Lists every shared video, newest first, with the uploader's Twitch login (admin view).
 * @returns All shared videos, enabled or not.
 */
export async function listSharedVideos(): Promise<SharedOverlayVideoWithUploader[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT v.id, v.name, v.filename, v.uploaded_by, v.enabled, v.created_at,
            u.twitch_name AS uploader_login
     FROM shared_overlay_video v
     LEFT JOIN \`user\` u ON u.discord_id = v.uploaded_by
     ORDER BY v.created_at DESC, v.id DESC`,
  );
  return rows.map((r) => ({ ...toVideo(r), uploader_login: r.uploader_login ?? null }));
}

/**
 * Lists the enabled shared videos, newest first (overlay and Stream Deck list).
 * @returns Enabled shared videos only.
 */
export async function listEnabledSharedVideos(): Promise<SharedOverlayVideo[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, name, filename, uploaded_by, enabled, created_at
     FROM shared_overlay_video WHERE enabled = TRUE
     ORDER BY created_at DESC, id DESC`,
  );
  return rows.map(toVideo);
}

/**
 * Fetches one shared video.
 * @param id - Primary key of the `shared_overlay_video` row.
 * @returns The video, or null if it doesn't exist.
 */
export async function getSharedVideo(id: number): Promise<SharedOverlayVideo | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, name, filename, uploaded_by, enabled, created_at
     FROM shared_overlay_video WHERE id = ?`,
    [id],
  );
  return rows[0] ? toVideo(rows[0]) : null;
}

/**
 * Adds a shared video. The caller creates the file at `filename` (new for every upload).
 * @param name - Display name.
 * @param filename - Unique stored filename inside the shared folder.
 * @param uploadedBy - Discord snowflake of the uploader, or null.
 * @returns The new row's id.
 */
export async function addSharedVideo(
  name: string,
  filename: string,
  uploadedBy: string | null,
): Promise<number> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `INSERT INTO shared_overlay_video (name, filename, uploaded_by) VALUES (?, ?, ?)`,
    [name, filename, uploadedBy],
  );
  return result.insertId;
}

/**
 * Renames a shared video.
 * @param id - Primary key of the row.
 * @param name - New display name.
 * @returns True if the video exists, false if not found.
 */
export async function renameSharedVideo(id: number, name: string): Promise<boolean> {
  // MySQL reports affectedRows = matched rows here (the pool sets FOUND_ROWS), so an unchanged name still counts.
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE shared_overlay_video SET name = ? WHERE id = ?`,
    [name, id],
  );
  return result.affectedRows > 0;
}

/**
 * Enables or disables a shared video.
 * @param id - Primary key of the row.
 * @param enabled - New enabled flag.
 * @returns True if the video exists, false if not found.
 */
export async function setSharedVideoEnabled(id: number, enabled: boolean): Promise<boolean> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE shared_overlay_video SET enabled = ? WHERE id = ?`,
    [enabled, id],
  );
  return result.affectedRows > 0;
}

/**
 * Removes a shared video.
 * @param id - Primary key of the row.
 * @returns The removed row's filename (for disk cleanup), or null if it didn't exist.
 */
export async function removeSharedVideo(id: number): Promise<string | null> {
  return withTransactionOrNotFound(async (conn, notFound) => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT filename FROM shared_overlay_video WHERE id = ? FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (!row) return notFound();
    await conn.execute(`DELETE FROM shared_overlay_video WHERE id = ?`, [id]);
    return row.filename as string;
  });
}
