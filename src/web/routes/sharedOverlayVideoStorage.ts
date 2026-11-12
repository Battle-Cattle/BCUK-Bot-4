import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { OVERLAY_FOLDER } from '../../shared/config';
import { createLogger } from '../../shared/logger';
import { addSharedVideo } from '../../db';
import { storeMovAsWebm } from './overlayMovConversion';
import type { ProgressListener } from './overlayVideoTranscode';
import { SHARED_FOLDER, resolveSharedVideoPath } from './sharedOverlayVideoFiles';

// Writing shared overlay videos (#917) to disk and the DB. Kept apart from sharedOverlayVideoFiles.ts
// so the routes that only resolve a path don't load the ffmpeg conversion code.

const log = createLogger('SharedOverlayVideoStorage');

/**
 * Converts a video to WebM into the shared folder under a new name, creating the folder first.
 * Every shared video is converted, whatever its type (WebM, MP4 or MOV), so all stored copies
 * share one format. Conversion progress goes to `onProgress`.
 * @param placeSource - Puts the source video at the path it is given (ffmpeg reads from there).
 * @param onProgress - Told the conversion's stage and percentage as it goes (optional).
 * @returns The stored WebM's filename within the shared folder.
 * @throws With `code: 'transcode_busy'` or `'transcode_failed'` if the video can't be converted,
 *   or the error from `placeSource` or from creating the folder.
 */
export async function storeSharedVideo(
  placeSource: (sourcePath: string) => Promise<void>,
  onProgress?: ProgressListener,
): Promise<string> {
  const dir = path.resolve(OVERLAY_FOLDER, SHARED_FOLDER);
  await fs.promises.mkdir(dir, { recursive: true });
  return storeMovAsWebm(dir, randomUUID(), placeSource, onProgress);
}

/**
 * Removes a shared video's file, logging instead of throwing: a leftover file is harmless.
 * @param filename - The video's stored filename.
 * @returns Resolves once removal has been attempted; never rejects.
 */
export async function removeSharedVideoFile(filename: string): Promise<void> {
  const filePath = resolveSharedVideoPath(filename);
  if (!filePath) return;
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch (err) {
    log.error(`Failed to remove shared overlay video ${filePath}:`, err);
  }
}

/**
 * Records a stored shared video in the DB, deleting the file again if the insert fails so no file
 * is left without a row.
 * @param name - Display name.
 * @param filename - The stored file's name within the shared folder.
 * @param uploadedBy - Discord snowflake of the Manager who added it.
 * @returns The new row's id.
 * @throws The DB error, after removing the file.
 */
export async function recordSharedVideo(name: string, filename: string, uploadedBy: string): Promise<number> {
  try {
    return await addSharedVideo(name, filename, uploadedBy);
  } catch (err) {
    await removeSharedVideoFile(filename);
    throw err;
  }
}
