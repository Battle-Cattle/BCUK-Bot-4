import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import multer from 'multer';
import { OVERLAY_FOLDER } from '../../shared/config';
import { createLogger } from '../../shared/logger';
import { detectVideoType } from './uploadFileTypes';
import { readFileHeader, sweepStaleTempFiles } from './overlayFiles';

// Where Multer writes overlay video uploads while they arrive. Overlay videos can be hundreds of
// megabytes (a transparent ProRes MOV especially), so they stream to disk rather than being
// held in memory. The folder sits inside OVERLAY_FOLDER so that moving a finished upload into its
// streamer's folder is a rename on the same disk, and its name isn't a streamer ID, so the
// overlay source route (which only serves `<numeric id>/<name>.webm|mp4`) never serves from it.

const log = createLogger('OverlayUploadStorage');

/** Folder that holds uploads while they arrive, before they're checked and moved into place. */
export const INCOMING_DIR = path.join(OVERLAY_FOLDER, '.incoming');

/** Suffix of an upload Multer is writing (or has written) to {@link INCOMING_DIR}. */
const INCOMING_SUFFIX = '.incoming';

/**
 * Paths of the uploads {@link overlayUploadStorage} has stored and not yet moved or removed,
 * keyed by the name it gave each one. The functions below find an upload's file through this
 * map rather than building a path from the request's file record, so only a path this process
 * created can ever be read, moved or removed.
 */
const storedUploads = new Map<string, string>();

/**
 * The stored name of each upload Multer is still writing, by its file object, so a write that
 * fails partway can be cleaned up: Multer itself only removes files whose write completed.
 */
const writingUploads = new WeakMap<object, string>();

/** Bytes read from the start of an upload to detect its type. */
const HEADER_BYTES = 16;

/** The video formats an overlay upload can be, from `detectVideoType`. */
export type OverlayVideoType = 'webm' | 'mp4' | 'mov';

/**
 * Multer storage engine for overlay uploads: streams each file to a random `.incoming` name in
 * {@link INCOMING_DIR}, creating the folder when needed, and records its path in
 * {@link storedUploads}. A file whose write fails partway (e.g. the disk is full) is removed
 * here; Multer removes one that's too large, which also forgets it; the route removes the rest
 * after handling them.
 */
export const overlayUploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.promises.mkdir(INCOMING_DIR, { recursive: true }).then(
      () => cb(null, INCOMING_DIR),
      (err: unknown) => cb(err instanceof Error ? err : new Error(String(err)), INCOMING_DIR),
    );
  },
  filename: (_req, file, cb) => {
    const name = `${randomUUID()}${INCOMING_SUFFIX}`;
    storedUploads.set(name, path.join(INCOMING_DIR, name));
    writingUploads.set(file, name);
    cb(null, name);
  },
});
const removeStoredFile = overlayUploadStorage._removeFile.bind(overlayUploadStorage);
overlayUploadStorage._removeFile = (req, file, cb) => {
  storedUploads.delete(file.filename);
  removeStoredFile(req, file, cb);
};
const handleStoredFile = overlayUploadStorage._handleFile.bind(overlayUploadStorage);
overlayUploadStorage._handleFile = (req, file, cb) => {
  handleStoredFile(req, file, (err, info) => {
    const name = writingUploads.get(file);
    writingUploads.delete(file);
    if (!err || name === undefined) {
      cb(err, info);
      return;
    }
    // The write failed partway (e.g. ENOSPC): remove what was written before reporting it.
    void removeFailedWrite(name).then(() => cb(err));
  });
};

/**
 * Removes an upload whose write failed partway, and forgets it.
 * @param name - The stored name {@link overlayUploadStorage} generated for it (never one taken
 *   from the request).
 * @returns Resolves once removal has been attempted; never rejects.
 */
async function removeFailedWrite(name: string): Promise<void> {
  storedUploads.delete(name);
  try {
    await fs.promises.rm(path.join(INCOMING_DIR, name), { force: true });
  } catch (err) {
    log.error(`Failed to remove partially written overlay upload ${name}:`, err);
  }
}

/**
 * Finds where an upload is on disk: the path {@link overlayUploadStorage} recorded when it stored
 * the file, looked up by the file's stored name.
 * @param file - The Multer upload, stored by {@link overlayUploadStorage}.
 * @returns Absolute path of the stored upload.
 * @throws If this process didn't store (or has already moved or removed) a file by that name.
 */
function incomingPath(file: Express.Multer.File): string {
  const storedPath = storedUploads.get(file.filename);
  if (storedPath === undefined) throw new Error('Unknown overlay upload');
  return storedPath;
}

/**
 * Detects an uploaded video's type from its first bytes on disk (see `detectVideoType`).
 * @param file - The Multer upload, stored by {@link overlayUploadStorage}.
 * @returns The detected format, or null when it isn't a WebM, MP4 or MOV.
 * @throws If the uploaded file can't be read, or this process has no stored upload by that name.
 */
export async function detectUploadedVideoType(file: Express.Multer.File): Promise<OverlayVideoType | null> {
  return detectVideoType(await readFileHeader(incomingPath(file), HEADER_BYTES));
}

/**
 * Moves an uploaded file to `destPath`. That's a rename when both are on the same disk; if
 * `destPath` is on another one (the streamer's folder is a mount or symlink elsewhere), the file
 * is copied and the upload removed instead.
 * @param file - The Multer upload, stored by {@link overlayUploadStorage}.
 * @param destPath - Absolute path to move it to.
 * @returns Resolves once the file is at `destPath`.
 * @throws If it can't be moved (a partial copy at `destPath` is removed first), or this process
 *   has no stored upload by that name.
 */
export async function placeUpload(file: Express.Multer.File, destPath: string): Promise<void> {
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
 * @param file - The Multer upload, stored by {@link overlayUploadStorage}.
 * @returns Resolves once removal has been attempted; never rejects.
 */
export async function discardUpload(file: Express.Multer.File): Promise<void> {
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
