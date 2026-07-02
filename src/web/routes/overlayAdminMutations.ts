import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import type { DbStreamerEventSub } from '../../db';
import { addVideo, deleteVideo } from '../../db';
import { OVERLAY_FOLDER, OVERLAY_MAX_FILE_MB } from '../../shared/config';
import { parsePositiveIntId } from './shared';
import { safeResolve } from '../../shared/pathUtils';
import { requireStreamer } from './overlayAdminShared';

export { requireStreamer, toStringArray, parseWeight } from './overlayAdminShared';

const log = createLogger('OverlayAdmin');
export const router = Router();

/** Maximum upload size in megabytes, passed to templates to avoid direct process.env access in EJS. */
export const MAX_UPLOAD_MB = OVERLAY_MAX_FILE_MB;
const MAX_FILE_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// No fileFilter: client-supplied MIME type is unreliable (some browsers send
// application/octet-stream). detectVideoType() validates via magic bytes instead,
// mirroring the audio upload approach.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

/**
 * Detect video type from buffer magic bytes, independent of the client-supplied MIME type.
 * WebM: EBML header 0x1A 0x45 0xDF 0xA3
 * MP4: ftyp box signature at bytes 4–7: 0x66 0x74 0x79 0x70
 */
export function detectVideoType(buf: Buffer): 'webm' | 'mp4' | null {
  if (buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return 'webm';
  }
  if (buf.subarray(4, 8).equals(Buffer.from([0x66, 0x74, 0x79, 0x70]))) {
    return 'mp4';
  }
  return null;
}

async function saveVideoFile(streamer: DbStreamerEventSub, file: Express.Multer.File, name: string): Promise<void> {
  const dir = safeResolve(OVERLAY_FOLDER, String(streamer.id));
  if (!dir) throw Object.assign(new Error('Path traversal blocked'), { code: 'invalid_path' });
  const ext = detectVideoType(file.buffer);
  if (!ext) throw Object.assign(new Error('Invalid file type'), { code: 'invalid_file' });
  const filename = `${randomUUID()}.${ext}`;
  await fs.promises.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  await fs.promises.writeFile(fullPath, file.buffer);
  try {
    await addVideo(streamer.id, name, filename);
  } catch (e) {
    await fs.promises.rm(fullPath, { force: true });
    throw e;
  }
  log.info(`Overlay video uploaded for ${streamer.twitch_name}: ${filename}`);
}

/**
 * Translate a Multer error into a user-facing redirect, instead of letting it
 * reach the centralised 500 handler. An oversized file (`LIMIT_FILE_SIZE`) gets
 * the `file_too_large` code; any other error falls back to `upload_failed`.
 * @param err - The error passed by Multer's callback, or null/undefined if none.
 * @param res - Express response used to issue the redirect when an error occurred.
 * @returns true when `err` was an error and a redirect was sent (caller should
 *   stop); false when there was no error (caller should continue).
 */
export function handleUploadError(err: unknown, res: Response): boolean {
  if (!err) return false;
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    res.redirect('/overlay/settings?error=file_too_large');
    return true;
  }
  log.error('Overlay upload middleware error:', err);
  res.redirect('/overlay/settings?error=upload_failed');
  return true;
}

/**
 * Express middleware that runs Multer's single-file (`video`) parser and, on a
 * Multer error (e.g. an oversized file), redirects via `handleUploadError`
 * instead of letting it fall through to the centralised 500 handler.
 * @param req - Express request carrying the multipart upload.
 * @param res - Express response (used for the error redirect).
 * @param next - Called to continue to the route handler when parsing succeeds.
 * @returns {void}
 */
function uploadVideo(req: Request, res: Response, next: NextFunction): void {
  upload.single('video')(req, res, (err: unknown) => {
    if (handleUploadError(err, res)) return;
    next();
  });
}

/**
 * POST /overlay/settings/videos/upload — uploads a video file (webm/mp4,
 * validated by magic bytes) for the requesting streamer. csrfProtection runs
 * BEFORE uploadVideo so a bad token is rejected before Multer buffers the
 * file; the client (overlayAdmin.js) sends the token in an X-CSRF-Token
 * header — available before body parsing and never placed in the URL.
 * @param req - Express request; reads `name` and the `video` file from
 *   `req.body`/`req.file`.
 * @param res - Express response; redirects to `/overlay/settings?success=video_uploaded`
 *   on success, or to `/overlay/settings?error=<code>` if the requester isn't a
 *   streamer (`not_a_streamer`), no file was uploaded or it failed magic-byte
 *   validation (`invalid_file`), the resolved storage path is unsafe
 *   (`invalid_path`), the file exceeds the size limit (`file_too_large`,
 *   redirected by `handleUploadError`), or saving fails (`upload_failed`).
 */
router.post('/settings/videos/upload', requireAuth, csrfProtection, uploadVideo, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;
    if (!req.file) return res.redirect('/overlay/settings?error=invalid_file');
    const name = (typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '') || req.file.originalname.trim().slice(0, 100);
    await saveVideoFile(streamer, req.file, name);
    res.redirect('/overlay/settings?success=video_uploaded');
  } catch (err: unknown) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'invalid_path') return res.redirect('/overlay/settings?error=invalid_path');
    if (code === 'invalid_file') return res.redirect('/overlay/settings?error=invalid_file');
    log.error('Overlay video upload error:', err);
    res.redirect('/overlay/settings?error=upload_failed');
  }
});

/**
 * POST /overlay/settings/videos/:id/delete — deletes a video belonging to the
 * requesting streamer, removing both its DB row and file on disk.
 * @param req - Express request; reads the `id` route param.
 * @param res - Express response; redirects to `/overlay/settings?success=video_deleted`
 *   on success, or to `/overlay/settings?error=<code>` if the requester isn't a
 *   streamer (`not_a_streamer`), `id` is malformed (`invalid_id`), or the delete
 *   fails (`delete_failed`).
 */
router.post('/settings/videos/:id/delete', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const videoId = parsePositiveIntId(req.params.id);
    if (videoId === null) return res.redirect('/overlay/settings?error=invalid_id');

    const filename = await deleteVideo(videoId, streamer.id);
    if (filename) {
      const filePath = safeResolve(OVERLAY_FOLDER, String(streamer.id), filename);
      if (filePath) await fs.promises.rm(filePath, { force: true });
    }

    res.redirect('/overlay/settings?success=video_deleted');
  } catch (err) {
    log.error('Overlay video delete error:', err);
    res.redirect('/overlay/settings?error=delete_failed');
  }
});
