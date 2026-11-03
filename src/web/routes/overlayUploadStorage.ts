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

/** The name {@link overlayUploadStorage} gives an upload: a random UUID plus {@link INCOMING_SUFFIX}. */
const INCOMING_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.incoming$/;

/** Bytes read from the start of an upload to detect its type. */
const HEADER_BYTES = 16;

/** The video formats an overlay upload can be, from `detectVideoType`. */
export type OverlayVideoType = 'webm' | 'mp4' | 'mov';

/**
 * Multer storage engine for overlay uploads: streams each file to a random `.incoming` name in
 * {@link INCOMING_DIR}, creating the folder when needed. Multer itself removes the file if the
 * upload fails partway (e.g. it's too large); the route removes it after handling it.
 */
export const overlayUploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.promises.mkdir(INCOMING_DIR, { recursive: true }).then(
      () => cb(null, INCOMING_DIR),
      (err: unknown) => cb(err instanceof Error ? err : new Error(String(err)), INCOMING_DIR),
    );
  },
  filename: (_req, _file, cb) => cb(null, `${randomUUID()}${INCOMING_SUFFIX}`),
});

/**
 * Works out where an upload is on disk from its stored name, rather than trusting the path on the
 * request's file record: the name must be one {@link overlayUploadStorage} generates, so the path
 * is always directly inside {@link INCOMING_DIR}.
 * @param file - The Multer upload, stored by {@link overlayUploadStorage}.
 * @returns Absolute path of the stored upload.
 * @throws If the file record's name isn't one the storage engine generates.
 */
function incomingPath(file: Express.Multer.File): string {
  const name = file.filename;
  if (!INCOMING_NAME_RE.test(name)) throw new Error('Unexpected overlay upload filename');
  return path.join(INCOMING_DIR, name);
}

/**
 * Detects an uploaded video's type from its first bytes on disk (see `detectVideoType`).
 * @param file - The Multer upload, stored by {@link overlayUploadStorage}.
 * @returns The detected format, or null when it isn't a WebM, MP4 or MOV.
 * @throws If the uploaded file can't be read, or its file record's name isn't one
 *   {@link overlayUploadStorage} generates.
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
 * @throws If it can't be moved (a partial copy at `destPath` is removed first), or its file
 *   record's name isn't one {@link overlayUploadStorage} generates.
 */
export async function placeUpload(file: Express.Multer.File, destPath: string): Promise<void> {
  const sourcePath = incomingPath(file);
  try {
    await fs.promises.rename(sourcePath, destPath);
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
 * Removes an upload from {@link INCOMING_DIR}, if it's still there, logging instead of throwing
 * on failure (a leftover is picked up by {@link sweepStaleIncomingUploads}).
 * @param file - The Multer upload, stored by {@link overlayUploadStorage}.
 * @returns Resolves once removal has been attempted; never rejects.
 */
export async function discardUpload(file: Express.Multer.File): Promise<void> {
  try {
    await fs.promises.rm(incomingPath(file), { force: true });
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
