import { createLogger } from '../../shared/logger';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import type { DbStreamerEventSub } from '../../db';
import { addVideo, deleteVideo } from '../../db';
import { OVERLAY_FOLDER, OVERLAY_MAX_FILE_MB } from '../../shared/config';
import { parsePositiveIntId } from './validation';
import { requireStreamer } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';
import { createMulterErrorRedirectHandler, makeUploadMiddleware, makeRequireStreamerBeforeUpload } from './uploadMiddleware';
import { safeResolve } from '../../shared/pathUtils';
import { NOT_A_STREAMER_REDIRECT } from './overlayAdminShared';
import { storeMovAsWebm } from './overlayMovConversion';
import { isWebmTranscodeQueueFull, type ProgressListener } from './overlayVideoTranscode';
import { parseUploadId, claimConversionProgress, setConversionProgress, releaseConversionProgress } from './overlayConversionProgress';
import {
  overlayUploadStorage, detectUploadedVideoType, placeUpload, discardUpload, sweepStaleIncomingUploads, type OverlayVideoType,
} from './overlayUploadStorage';

const log = createLogger('OverlayAdmin');

/**
 * Most overlay uploads in progress at once. Each can stream up to the size limit into
 * `OVERLAY_FOLDER/.incoming`, so this bounds the disk a burst of uploads can take before any of
 * them is checked.
 */
export const MAX_CONCURRENT_OVERLAY_UPLOADS = 3;

/** Number of overlay uploads in progress (see {@link MAX_CONCURRENT_OVERLAY_UPLOADS}). */
let activeUploads = 0;

/** Error codes `saveVideoFile` throws that the upload route reports as themselves. */
const UPLOAD_ERROR_CODES = new Set(['invalid_path', 'invalid_file', 'transcode_failed', 'transcode_busy']);
export const router = Router();

/** Maximum upload size in megabytes, passed to templates to avoid direct process.env access in EJS. */
export const MAX_UPLOAD_MB = OVERLAY_MAX_FILE_MB;
const MAX_FILE_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/**
 * True if the client says the upload is a QuickTime file, by its name or MIME type. That claim
 * can't be trusted to accept a file (magic bytes decide that), only to turn one away early.
 * @param file - Multer's description of the incoming file, before its bytes are read.
 * @returns True for a `.mov` name or a `video/quicktime` type.
 */
function declaresMov(file: Express.Multer.File): boolean {
  return file.mimetype === 'video/quicktime' || path.extname(file.originalname).toLowerCase() === '.mov';
}

/**
 * Multer `fileFilter`: refuses a declared MOV with `transcode_busy` when the conversion queue is
 * already full, before Multer stores any of it. Every other upload (and a MOV sent under
 * another name) is let through; `detectUploadedVideoType()` still validates the bytes, and
 * `transcodeToWebm` still enforces the limit for a MOV this check didn't recognise.
 * @param _req - Express request (unused).
 * @param file - Multer's description of the incoming file.
 * @param cb - Multer's callback: an error to refuse the file, or `true` to accept it.
 */
function admitUpload(_req: Express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback): void {
  if (declaresMov(file) && isWebmTranscodeQueueFull()) {
    cb(Object.assign(new Error('Too many WebM conversions pending'), { code: 'transcode_busy' }));
    return;
  }
  cb(null, true);
}

// Overlay videos stream to disk (see overlayUploadStorage.ts) rather than memory: a transparent
// MOV can be hundreds of megabytes.
const upload = multer({
  storage: overlayUploadStorage,
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: admitUpload,
});

/**
 * Moves an uploaded overlay video into `dir` under a random name: WebM and MP4 as uploaded, MOV
 * converted to WebM first (see `storeMovAsWebm`).
 * @param dir - Absolute path of the streamer's overlay folder (already safe-resolved).
 * @param file - The Multer upload, stored on disk by `overlayUploadStorage`.
 * @param type - The upload's format, from `detectUploadedVideoType`.
 * @param onProgress - Told a MOV conversion's stage and percentage as it goes (optional).
 * @returns The stored file's name within `dir`.
 * @throws With `code: 'transcode_busy'`/`'transcode_failed'` if a MOV can't be converted now
 *   or at all, or the error from moving the file.
 */
async function storeVideoFile(dir: string, file: Express.Multer.File, type: OverlayVideoType, onProgress?: ProgressListener): Promise<string> {
  const baseName = randomUUID();
  if (type === 'mov') return storeMovAsWebm(dir, baseName, (sourcePath) => placeUpload(file, sourcePath), onProgress);
  const filename = `${baseName}.${type}`;
  await placeUpload(file, path.join(dir, filename));
  return filename;
}

/**
 * Stores an uploaded video (see {@link storeVideoFile}), publishing a MOV conversion's progress
 * under `uploadId` for the settings page to poll while it runs, and clearing it afterwards. If
 * another request is already using the same upload ID, this one just isn't tracked.
 * @param streamer - Owning streamer.
 * @param dir - Absolute path of the streamer's overlay folder (already safe-resolved).
 * @param file - The Multer upload, stored on disk by `overlayUploadStorage`.
 * @param details - The upload's detected format and, when the page sent one, its upload ID.
 * @returns The stored file's name within `dir`.
 * @throws Whatever {@link storeVideoFile} throws.
 */
async function storeWithProgress(
  streamer: DbStreamerEventSub,
  dir: string,
  file: Express.Multer.File,
  details: { type: OverlayVideoType; uploadId: string | null },
): Promise<string> {
  const { type, uploadId } = details;
  const owner = uploadId && type === 'mov' ? claimConversionProgress(streamer.id, uploadId) : null;
  if (!uploadId || !owner) return storeVideoFile(dir, file, type);
  try {
    return await storeVideoFile(dir, file, type, (progress) => setConversionProgress(streamer.id, uploadId, owner, progress));
  } finally {
    releaseConversionProgress(streamer.id, uploadId, owner);
  }
}

/**
 * Stores an uploaded overlay video in the streamer's folder (see {@link storeVideoFile}) and
 * records it in the DB, deleting the file again if the DB insert fails.
 * @param streamer - Owning streamer.
 * @param file - The Multer upload, stored on disk by `overlayUploadStorage`.
 * @param name - Display name for the video.
 * @param uploadId - The page's ID for this upload (`X-Upload-Id`), or null when it sent none.
 * @returns Resolves once the file is saved and recorded.
 * @throws With `code: 'invalid_path'`, `'invalid_file'`, `'transcode_busy'` or `'transcode_failed'`
 *   for a bad path, a non-video upload, a full conversion queue or a MOV that couldn't be converted.
 */
async function saveVideoFile(streamer: DbStreamerEventSub, file: Express.Multer.File, name: string, uploadId: string | null): Promise<void> {
  const dir = safeResolve(OVERLAY_FOLDER, String(streamer.id));
  if (!dir) throw Object.assign(new Error('Path traversal blocked'), { code: 'invalid_path' });
  const type = await detectUploadedVideoType(file);
  if (!type) throw Object.assign(new Error('Invalid file type'), { code: 'invalid_file' });
  await fs.promises.mkdir(dir, { recursive: true });
  const filename = await storeWithProgress(streamer, dir, file, { type, uploadId });
  const fullPath = path.join(dir, filename);
  try {
    await addVideo(streamer.id, name, filename);
  } catch (e) {
    await fs.promises.rm(fullPath, { force: true });
    throw e;
  }
  log.info(`Overlay video uploaded for ${streamer.twitch_name}: ${filename}${type === 'mov' ? ' (converted from MOV)' : ''}`);
}

/** Redirects a Multer error: `file_too_large` for an oversized file, `upload_failed` otherwise. */
const redirectMulterError = createMulterErrorRedirectHandler('/overlay/settings', log, 'Overlay upload middleware error:');

/**
 * Translate an upload-middleware error into a user-facing redirect, instead of letting it reach
 * the centralised 500 handler: `transcode_busy` from {@link admitUpload}, `file_too_large` for an
 * oversized file, and `upload_failed` for anything else. Also starts a sweep of stale incoming
 * uploads, since a rejected upload never reaches the route handler that normally runs it.
 * @param err - The error passed by Multer's callback, or null/undefined if none.
 * @param res - Express response used to issue the redirect when an error occurred.
 * @returns true when `err` was an error and a redirect was sent (caller should stop); false when
 *   there was no error (caller should continue).
 */
export function handleUploadError(err: unknown, res: Response): boolean {
  // A rejected upload never reaches the route handler, so sweep leftovers from here too.
  if (err) void sweepStaleIncomingUploads();
  if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'transcode_busy') {
    res.redirect('/overlay/settings?error=transcode_busy');
    return true;
  }
  return redirectMulterError(err, res);
}

/**
 * Express middleware admitting an upload only while fewer than
 * {@link MAX_CONCURRENT_OVERLAY_UPLOADS} are in progress, before Multer stores any of it; a
 * further one is turned away with `upload_busy`. The slot is released once the response has
 * been sent or the connection closes, whichever comes first.
 * @param _req - Express request (unused).
 * @param res - Express response; redirected when the limit is reached.
 * @param next - Continues to Multer when the upload is admitted.
 */
export function limitConcurrentUploads(_req: Request, res: Response, next: NextFunction): void {
  if (activeUploads >= MAX_CONCURRENT_OVERLAY_UPLOADS) {
    res.redirect('/overlay/settings?error=upload_busy');
    return;
  }
  activeUploads++;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    activeUploads--;
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}

/** Express middleware running Multer's single-file (`video`) parser, redirecting on error. */
const uploadVideo = makeUploadMiddleware(upload, 'video', handleUploadError);

/** Redirects non-streamers before Multer buffers the upload (see `makeRequireStreamerBeforeUpload`). */
const requireStreamerBeforeUpload = makeRequireStreamerBeforeUpload({
  notAStreamerRedirect: NOT_A_STREAMER_REDIRECT,
  basePath: '/overlay/settings',
  log,
  logLabel: 'Overlay video upload streamer check error:',
});

/**
 * Handles one overlay video upload once Multer has stored it: stores and records it, and
 * redirects with the outcome (see the route below for the redirect codes).
 * @param req - Express request; reads `name`, the `video` file and the `X-Upload-Id` header.
 * @param res - Express response, redirected to `/overlay/settings` with the outcome.
 * @returns Resolves once the response has been sent.
 */
async function handleVideoUpload(req: Request, res: Response): Promise<void> {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;
    if (!req.file) return res.redirect('/overlay/settings?error=invalid_file');
    const name = (typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '') || req.file.originalname.trim().slice(0, 100);
    await saveVideoFile(streamer, req.file, name, parseUploadId(req.get('x-upload-id')));
    res.redirect('/overlay/settings?success=video_uploaded');
  } catch (err: unknown) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code && UPLOAD_ERROR_CODES.has(code)) return res.redirect(`/overlay/settings?error=${code}`);
    logAndRedirectError({ res, log, logLabel: 'Overlay video upload error:', err, basePath: '/overlay/settings', errorCode: 'upload_failed' });
  }
}

/**
 * POST /overlay/settings/videos/upload — uploads a video file (webm/mp4/mov,
 * validated by magic bytes; a mov is converted to webm) for the requesting streamer. An
 * `X-Upload-Id` header (32 lowercase hex characters) lets the page poll a MOV's conversion
 * progress at `GET /overlay/settings/videos/progress/:uploadId` while this request runs.
 * csrfProtection and requireStreamerBeforeUpload run BEFORE uploadVideo so a bad token or a
 * non-streamer is rejected before Multer stores the file; the client (utils.js) sends the token
 * in an X-CSRF-Token header — available before body parsing and never placed in the URL. The
 * upload is streamed to disk and always removed from the incoming folder afterwards.
 * @param req - Express request; reads `name` and the `video` file from
 *   `req.body`/`req.file`.
 * @param res - Express response; redirects to `/overlay/settings?success=video_uploaded`
 *   on success, or to `/overlay/settings?error=<code>` if the requester isn't a
 *   streamer (`not_a_streamer`), no file was uploaded or it failed magic-byte
 *   validation (`invalid_file`), a mov couldn't be converted (`transcode_failed`) or
 *   too many are already converting (`transcode_busy`), too many uploads are already in
 *   progress (`upload_busy`, redirected by `limitConcurrentUploads` before Multer runs),
 *   the resolved storage path is unsafe
 *   (`invalid_path`), the file exceeds the size limit (`file_too_large`,
 *   redirected by `handleUploadError`), or saving fails (`upload_failed`).
 */
router.post('/settings/videos/upload', requireAuth, csrfProtection, requireStreamerBeforeUpload, limitConcurrentUploads, uploadVideo, async (req, res) => {
  try {
    await handleVideoUpload(req, res);
  } finally {
    // Whatever happened, nothing is left in the incoming folder: a stored upload was moved out
    // already, and anything else (rejected, failed) is removed here.
    if (req.file) await discardUpload(req.file);
    await sweepStaleIncomingUploads();
  }
});

/**
 * Post-commit cleanup after a video's DB row is deleted: removes its file from disk. The row is
 * already gone by this point, so a failed removal must not turn an already-successful delete into
 * a `delete_failed` response — it's logged and just leaves a stale file on disk.
 * @param streamerId - DB row ID of the owning streamer (the file's subfolder).
 * @param filename - The deleted video's stored filename.
 * @returns Resolves once removal has been attempted; never rejects.
 */
async function removeDeletedVideoFile(streamerId: number, filename: string): Promise<void> {
  const filePath = safeResolve(OVERLAY_FOLDER, String(streamerId), filename);
  if (!filePath) return;
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch (err) {
    log.error(`Failed to remove orphaned overlay video ${filePath}:`, err);
  }
}

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
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const videoId = parsePositiveIntId(req.params.id);
    if (videoId === null) return res.redirect('/overlay/settings?error=invalid_id');

    const filename = await deleteVideo(videoId, streamer.id);
    if (filename) await removeDeletedVideoFile(streamer.id, filename);

    res.redirect('/overlay/settings?success=video_deleted');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Overlay video delete error:', err, basePath: '/overlay/settings', errorCode: 'delete_failed' });
  }
});
