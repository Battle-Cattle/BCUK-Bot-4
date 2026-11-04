import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { FinishedChunkedUpload } from '../chunkedUploadStore';
import type { UploadedFile } from '../uploadedFile';
import { OVERLAY_FOLDER } from '../../shared/config';
import { createLogger } from '../../shared/logger';
import { detectVideoType } from './uploadFileTypes';
import { readFileHeader, sweepStaleTempFiles } from './overlayFiles';

// Where finished overlay video uploads wait to be checked and stored (their chunked-upload
// sessions live in `chunked/` inside it). Overlay videos can be hundreds of megabytes (a
// transparent ProRes MOV especially), so they stay on disk rather than being held in memory. The folder sits inside OVERLAY_FOLDER so that moving a finished upload into its
// streamer's folder is a rename on the same disk, and its name isn't a streamer ID, so the
// overlay source route (which only serves `<numeric id>/<name>.webm|mp4`) never serves from it.

const log = createLogger('OverlayUploadStorage');

/** Folder that holds uploads while they arrive, before they're checked and moved into place. */
export const INCOMING_DIR = path.join(OVERLAY_FOLDER, '.incoming');

/** Suffix of an upload adopted into {@link INCOMING_DIR}. */
const INCOMING_SUFFIX = '.incoming';

/**
 * Paths of the uploads {@link adoptChunkedUpload} has taken over and not yet moved or removed,
 * keyed by the name it gave each one. The functions below find an upload's file through this
 * map rather than building a path from the request's file record, so only a path this process
 * created can ever be read, moved or removed.
 */
const storedUploads = new Map<string, string>();

/** Bytes read from the start of an upload to detect its type. */
const HEADER_BYTES = 16;

/** The video formats an overlay upload can be, from `detectVideoType`. */
export type OverlayVideoType = 'webm' | 'mp4' | 'mov';

/**
 * Finds where an upload is on disk: the path {@link overlayUploadStorage} recorded when it stored
 * the file, looked up by the file's stored name.
 * @param file - The upload, taken over by {@link adoptChunkedUpload}.
 * @returns Absolute path of the stored upload.
 * @throws If this process didn't store (or has already moved or removed) a file by that name.
 */
function incomingPath(file: UploadedFile): string {
  const storedPath = storedUploads.get(file.filename);
  if (storedPath === undefined) throw new Error('Unknown overlay upload');
  return storedPath;
}

/**
 * Detects an uploaded video's type from its first bytes on disk (see `detectVideoType`).
 * @param file - The upload, taken over by {@link adoptChunkedUpload}.
 * @returns The detected format, or null when it isn't a WebM, MP4 or MOV.
 * @throws If the uploaded file can't be read, or this process has no stored upload by that name.
 */
export async function detectUploadedVideoType(file: UploadedFile): Promise<OverlayVideoType | null> {
  return detectVideoType(await readFileHeader(incomingPath(file), HEADER_BYTES));
}

/**
 * Moves an uploaded file to `destPath`. That's a rename when both are on the same disk; if
 * `destPath` is on another one (the streamer's folder is a mount or symlink elsewhere), the file
 * is copied and the upload removed instead.
 * @param file - The upload, taken over by {@link adoptChunkedUpload}.
 * @param destPath - Absolute path to move it to.
 * @returns Resolves once the file is at `destPath`.
 * @throws If it can't be moved (a partial copy at `destPath` is removed first), or this process
 *   has no stored upload by that name.
 */
export async function placeUpload(file: UploadedFile, destPath: string): Promise<void> {
  const sourcePath = incomingPath(file);
  try {
    await fs.promises.rename(sourcePath, destPath);
    storedUploads.delete(file.filename);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  try {
    await fs.promises.copyFile(sourcePath, destPath);
  } catch (err) {
    await fs.promises.rm(destPath, { force: true });
    throw err;
  }
  await discardUpload(file);
}

/**
 * Removes an upload from {@link INCOMING_DIR} if it's still there (it does nothing once the
 * upload has been moved into place), logging instead of throwing on failure (a leftover is
 * picked up by {@link sweepStaleIncomingUploads}).
 * @param file - The upload, taken over by {@link adoptChunkedUpload}.
 * @returns Resolves once removal has been attempted; never rejects.
 */
export async function discardUpload(file: UploadedFile): Promise<void> {
  const storedPath = storedUploads.get(file.filename);
  if (storedPath === undefined) return;
  try {
    await fs.promises.rm(storedPath, { force: true });
    storedUploads.delete(file.filename);
  } catch (err) {
    log.error(`Failed to remove overlay upload ${file.filename}:`, err);
  }
}

/**
 * Removes uploads left in {@link INCOMING_DIR} by earlier requests that couldn't clean up (e.g.
 * the bot restarted mid-upload), once they're too old to belong to an upload still arriving.
 * @returns Resolves once the sweep has finished; never rejects.
 */
export function sweepStaleIncomingUploads(): Promise<void> {
  return sweepStaleTempFiles(INCOMING_DIR, (name) => name.endsWith(INCOMING_SUFFIX));
}

/**
 * Takes over a file assembled by a chunked upload: moves it into {@link INCOMING_DIR} under a
 * random `.incoming` name and records it, so the overlay upload handler can check, place and
 * discard it.
 * @param finished - The finished chunked upload; its file must be on the same disk (the overlay
 *   chunk sessions live inside {@link INCOMING_DIR}).
 * @param field - Name of the form's file field.
 * @returns The file record for `req.file`.
 */
export async function adoptChunkedUpload(finished: FinishedChunkedUpload, field: string): Promise<UploadedFile> {
  await fs.promises.mkdir(INCOMING_DIR, { recursive: true });
  const name = `${randomUUID()}${INCOMING_SUFFIX}`;
  const fullPath = path.join(INCOMING_DIR, name);
  await fs.promises.rename(finished.path, fullPath);
  storedUploads.set(name, fullPath);
  return {
    fieldname: field,
    originalname: finished.name,
    mimetype: finished.type,
    size: finished.size,
    filename: name,
    path: fullPath,
    buffer: Buffer.alloc(0),
  };
}
