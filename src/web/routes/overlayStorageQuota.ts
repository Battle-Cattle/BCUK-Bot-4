import { getLibraryVideos, getVideosForStreamer } from '../../db';
import { OVERLAY_LIBRARY_MAX_TOTAL_MB, OVERLAY_MAX_TOTAL_MB_PER_STREAMER } from '../../shared/config';
import { createMutationQueue } from '../../shared/mutationQueue';
import { LIBRARY_FOLDER, streamerFolder, videoFileSize } from './overlayVideoLibraryFiles';

// Storage caps on stored overlay videos (#904): one total per streamer and one for the public
// library.
//
// Totals are summed from the DB rows, sizing each row's file on disk; the folder itself is never
// listed. So a streamer's total is exactly the videos their settings page lists, and deleting
// one always frees its space. A file left behind with no row (#966) counts against nobody, a row
// whose file is missing counts as nothing, and conversion temporary files aren't counted.
//
// Each hard link counts in full, so a video that is both a streamer's own and in the library, or
// imported by several streamers, counts once per row even though the disk holds the data once.

const BYTES_PER_MB = 1024 * 1024;

/** Most bytes of overlay video one streamer may store (`OVERLAY_MAX_TOTAL_MB_PER_STREAMER`). */
export const STREAMER_STORAGE_LIMIT_BYTES = OVERLAY_MAX_TOTAL_MB_PER_STREAMER * BYTES_PER_MB;

/** Most bytes the public library's files may add up to (`OVERLAY_LIBRARY_MAX_TOTAL_MB`). */
export const LIBRARY_STORAGE_LIMIT_BYTES = OVERLAY_LIBRARY_MAX_TOTAL_MB * BYTES_PER_MB;

/** Queue key for the public library's quota (streamers use `streamer:<id>`). */
const LIBRARY_KEY = 'library';

/** Serialises each quota's check-then-store steps, so two at once can't both fit under the cap. */
const quotaQueue = createMutationQueue();

/**
 * Adds up the sizes of the named files in one overlay video folder. A missing file adds nothing.
 * @param folder - The streamer's folder or the library folder.
 * @param filenames - Stored filenames, from the folder's DB rows.
 * @returns Their total size in bytes.
 * @throws Filesystem errors other than a missing file.
 */
async function totalFileBytes(folder: string, filenames: string[]): Promise<number> {
  let total = 0;
  // One at a time, so a long list can't crowd other filesystem work out of the threadpool.
  for (const filename of filenames) total += (await videoFileSize({ folder, filename })) ?? 0;
  return total;
}

/**
 * Measures what a streamer has stored: the files of their `overlay_video` rows (uploads and
 * library imports alike), summed from the rows rather than the folder (see the note above).
 * @param streamerId - DB row ID of the streamer.
 * @returns Total size in bytes of the streamer's stored overlay videos.
 */
export async function streamerStoredBytes(streamerId: number): Promise<number> {
  const videos = await getVideosForStreamer(streamerId);
  return totalFileBytes(streamerFolder(streamerId), videos.map((v) => v.filename));
}

/**
 * Measures what the public library has stored: the files of its `overlay_video_library` rows,
 * summed from the rows rather than the folder (see the note above).
 * @returns Total size in bytes of the library's files.
 */
export async function libraryStoredBytes(): Promise<number> {
  const entries = await getLibraryVideos();
  return totalFileBytes(LIBRARY_FOLDER, entries.map((e) => e.filename));
}

/**
 * True if the streamer has no room for any more video: their stored total is at or over the cap.
 * Used before an upload starts, when the size it will be stored at isn't known yet.
 * @param streamerId - DB row ID of the streamer.
 * @returns True at or over the cap.
 */
export async function isStreamerStorageFull(streamerId: number): Promise<boolean> {
  return (await streamerStoredBytes(streamerId)) >= STREAMER_STORAGE_LIMIT_BYTES;
}

/**
 * True if a new file of `newBytes` would take the streamer's stored total over the cap.
 * @param streamerId - DB row ID of the streamer.
 * @param newBytes - Size in bytes of the file about to be recorded (not yet one of their rows).
 * @returns True if it doesn't fit.
 */
export async function exceedsStreamerStorage(streamerId: number, newBytes: number): Promise<boolean> {
  return (await streamerStoredBytes(streamerId)) + newBytes > STREAMER_STORAGE_LIMIT_BYTES;
}

/**
 * True if a new file of `newBytes` would take the public library's total over its cap.
 * @param newBytes - Size in bytes of the file about to be added to the library.
 * @returns True if it doesn't fit.
 */
export async function exceedsLibraryStorage(newBytes: number): Promise<boolean> {
  return (await libraryStoredBytes()) + newBytes > LIBRARY_STORAGE_LIMIT_BYTES;
}

/**
 * Runs a streamer's check-then-store step with no other one for the same streamer running, so
 * an upload finishing and an import can't both pass the cap check before either is recorded.
 * `operation` must not call this again for the same streamer (see `createMutationQueue`).
 * @param streamerId - DB row ID of the streamer.
 * @param operation - Checks the cap and records the new video.
 * @returns `operation`'s result.
 */
export function withStreamerQuota<T>(streamerId: number, operation: () => Promise<T>): Promise<T> {
  return quotaQueue.run(`streamer:${streamerId}`, operation);
}

/**
 * Runs a library check-then-store step with no other one running, so two publishes can't both
 * pass the library cap check before either is recorded.
 * @param operation - Checks the cap and records the new library entry.
 * @returns `operation`'s result.
 */
export function withLibraryQuota<T>(operation: () => Promise<T>): Promise<T> {
  return quotaQueue.run(LIBRARY_KEY, operation);
}
