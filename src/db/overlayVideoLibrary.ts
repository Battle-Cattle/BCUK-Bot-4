import mysql from 'mysql2/promise';
import { getPool, withTransaction, withTransactionOrNotFound } from './pool';
import { isMysqlDuplicateEntryError } from './utils';

/** One entry in the public overlay video library, with its contributor's Twitch login. */
export interface OverlayLibraryVideo {
  id: number;
  name: string;
  filename: string;
  /** DB row ID of the streamer who added it; null once that streamer row is gone. */
  contributor_streamer_id: number | null;
  /** Twitch login of the contributor; null when the streamer row is gone or has no Twitch name. */
  contributor_login: string | null;
  /** The contributor's `overlay_video` it was added from; null once they deleted it. */
  source_video_id: number | null;
  created_at: Date;
}

/** Outcome of {@link addVideoToLibrary}. */
export type AddVideoToLibraryResult =
  | { status: 'added'; libraryId: number; sourceFilename: string }
  | { status: 'not_owner' }
  | { status: 'already_in_library' };

/** Name of the unique index that stops one video being added to the library twice. */
const SOURCE_VIDEO_UNIQUE_KEY = 'uq_overlay_video_library_source';

/**
 * Checks whether a duplicate-entry error came from the `source_video_id` unique index, as opposed
 * to the `filename` one (a filename collision is a caller bug, not "already in library").
 * @param err Value caught from the INSERT.
 * @returns True if `err` is a duplicate on `uq_overlay_video_library_source`.
 */
function isDuplicateSourceVideo(err: unknown): boolean {
  if (!isMysqlDuplicateEntryError(err)) return false;
  const message = (err as { sqlMessage?: string; message?: string }).sqlMessage
    ?? (err as { message?: string }).message ?? '';
  return message.includes(SOURCE_VIDEO_UNIQUE_KEY);
}

/**
 * Adds a streamer's overlay video to the public library, in one transaction: checks the streamer
 * owns the video (holding a shared lock on it so it can't be deleted mid-way), then inserts the
 * library row copying the video's `name`. The caller creates the library file at
 * `libraryFilename` from the returned `sourceFilename`.
 * @param videoId Primary key of the contributor's `overlay_video` row.
 * @param streamerId DB row ID of the streamer adding it; must own the video.
 * @param libraryFilename New, unique stored filename for the library's own copy of the file.
 * @returns `added` with the new library id and the source video's filename, `not_owner` if the
 *   video doesn't exist or belongs to another streamer, or `already_in_library` if it was added
 *   before.
 */
export async function addVideoToLibrary(
  videoId: number,
  streamerId: number,
  libraryFilename: string,
): Promise<AddVideoToLibraryResult> {
  return withTransaction(async (conn): Promise<AddVideoToLibraryResult> => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT name, filename FROM overlay_video WHERE id = ? AND streamer_id = ? FOR SHARE`,
      [videoId, streamerId],
    );
    const video = rows[0];
    if (!video) return { status: 'not_owner' };
    try {
      const [result] = await conn.execute<mysql.ResultSetHeader>(
        `INSERT INTO overlay_video_library (name, filename, contributor_streamer_id, source_video_id)
         VALUES (?, ?, ?, ?)`,
        [video.name, libraryFilename, streamerId, videoId],
      );
      return { status: 'added', libraryId: result.insertId, sourceFilename: video.filename };
    } catch (err) {
      if (isDuplicateSourceVideo(err)) return { status: 'already_in_library' };
      throw err;
    }
  });
}

/**
 * Fetches every library entry, newest first, with the contributor's Twitch login.
 * @returns All entries in the public overlay video library.
 */
export async function getLibraryVideos(): Promise<OverlayLibraryVideo[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT l.id, l.name, l.filename, l.contributor_streamer_id, l.source_video_id, l.created_at,
            u.twitch_name AS contributor_login
     FROM overlay_video_library l
     LEFT JOIN streamer s ON s.id = l.contributor_streamer_id
     LEFT JOIN \`user\` u ON u.discord_id = s.discord_id
     ORDER BY l.created_at DESC, l.id DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    filename: r.filename,
    contributor_streamer_id: r.contributor_streamer_id ?? null,
    contributor_login: r.contributor_login ?? null,
    source_video_id: r.source_video_id ?? null,
    created_at: r.created_at,
  }));
}

/**
 * Lists the library entries a streamer has imported at least one copy of, for the "already
 * added" markers.
 * @param streamerId DB row ID of the importing streamer.
 * @returns Distinct `overlay_video_library` ids the streamer's videos were imported from.
 */
export async function getImportedLibraryEntryIds(streamerId: number): Promise<number[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT DISTINCT library_entry_id FROM overlay_video
     WHERE streamer_id = ? AND library_entry_id IS NOT NULL`,
    [streamerId],
  );
  return rows.map((r) => r.library_entry_id);
}

/**
 * Imports a library entry as the streamer's own `overlay_video` row, copying its `name` and
 * recording `library_entry_id`. A single INSERT … SELECT, so an entry removed concurrently just
 * inserts nothing. The caller creates the file at `newFilename` first.
 * @param libraryId Primary key of the `overlay_video_library` row.
 * @param streamerId DB row ID of the importing streamer.
 * @param newFilename New, unique stored filename for the streamer's copy of the file.
 * @returns The new `overlay_video` id, or null if the library entry no longer exists.
 */
export async function importLibraryVideo(
  libraryId: number,
  streamerId: number,
  newFilename: string,
): Promise<number | null> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `INSERT INTO overlay_video (streamer_id, name, filename, library_entry_id)
     SELECT ?, name, ?, id FROM overlay_video_library WHERE id = ?`,
    [streamerId, newFilename, libraryId],
  );
  return result.affectedRows === 0 ? null : result.insertId;
}

/**
 * Removes a library entry. Not streamer-scoped: only an Admin may remove entries, which the
 * route enforces. Copies streamers imported keep their rows (`library_entry_id` becomes NULL).
 * @param libraryId Primary key of the `overlay_video_library` row.
 * @returns The removed entry's filename (for disk cleanup), or null if no such entry existed.
 */
export async function removeLibraryVideo(libraryId: number): Promise<string | null> {
  return withTransactionOrNotFound(async (conn, notFound) => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT filename FROM overlay_video_library WHERE id = ? FOR UPDATE`,
      [libraryId],
    );
    const row = rows[0];
    if (!row) return notFound();
    await conn.execute(`DELETE FROM overlay_video_library WHERE id = ?`, [libraryId]);
    return row.filename as string;
  });
}
