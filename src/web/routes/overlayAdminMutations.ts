import { createLogger } from '../../shared/logger';
import { Router, type NextFunction, type Request, type Response } from 'express';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import type { DbStreamerEventSub } from '../../db';
import { addVideo, deleteVideo, getStreamerByDiscordId } from '../../db';
import { getSessionUser } from '../session';
import { OVERLAY_FOLDER, OVERLAY_MAX_FILE_MB } from '../../shared/config';
import { parsePositiveIntId } from './validation';
import { requireStreamer } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';
import { makeRequireStreamerBeforeUpload } from './uploadMiddleware';
import type { UploadedFile } from '../uploadedFile';
import { ChunkedUploadStore } from '../chunkedUploadStore';
import type { ChunkedUploadDeclaration } from '../chunkedUploadDeclaration';
import { mountChunkedUploadRoutes } from './chunkedUploadRoutes';
import { safeResolve } from '../../shared/pathUtils';
import { NOT_A_STREAMER_REDIRECT } from './overlayAdminShared';
import { storeMovAsWebm } from './overlayMovConversion';
import { isWebmTranscodeQueueFull, type ProgressListener } from './overlayVideoTranscode';
import { parseUploadId, claimConversionProgress, setConversionProgress, releaseConversionProgress } from './overlayConversionProgress';
import {
  adoptChunkedUpload, INCOMING_DIR, detectUploadedVideoType, placeUpload, discardUpload, sweepStaleIncomingUploads, type OverlayVideoType,
} from './overlayUploadStorage';
import { streamerFolder, videoFileSize } from './overlayVideoLibraryFiles';
import { exceedsStreamerStorage, isStreamerStorageFull, withStreamerQuota } from './overlayStorageQuota';

const log = createLogger('OverlayAdmin');

/**
 * Most overlay uploads being completed (checked, converted and stored) at once, which bounds the
 * disk and CPU a burst of finished uploads can take while they're processed. Also the most
 * unfinished overlay uploads across all streamers (see `chunkedVideoStore`).
 */
export const MAX_CONCURRENT_OVERLAY_UPLOADS = 3;

/** Number of overlay uploads in progress (see {@link MAX_CONCURRENT_OVERLAY_UPLOADS}). */
let activeUploads = 0;

/** Error codes `saveVideoFile` throws that the upload route reports as themselves. */
const UPLOAD_ERROR_CODES = new Set(['invalid_path', 'invalid_file', 'transcode_failed', 'transcode_busy', 'storage_limit']);
export const router = Router();

/** Maximum upload size in megabytes, passed to templates to avoid direct process.env access in EJS. */
export const MAX_UPLOAD_MB = OVERLAY_MAX_FILE_MB;
const MAX_FILE_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/**
 * True if the client says the upload is a QuickTime file, by its name or MIME type. That claim
 * can't be trusted to accept a file (magic bytes decide that), only to turn one away early.
 * @param name - The file name the client sent.
 * @param type - The MIME type the client sent.
 * @returns True for a `.mov` name or a `video/quicktime` type.
 */
function declaresMov(name: string, type: string): boolean {
  return type === 'video/quicktime' || path.extname(name).toLowerCase() === '.mov';
}

/**
 * Moves an uploaded overlay video into `dir` under a random name: WebM and MP4 as uploaded, MOV
 * converted to WebM first (see `storeMovAsWebm`).
 * @param dir - Absolute path of the streamer's overlay folder (already safe-resolved).
 * @param file - The finished upload, kept on disk in the incoming folder (see `adoptChunkedUpload`).
 * @param type - The upload's format, from `detectUploadedVideoType`.
 * @param onProgress - Told a MOV conversion's stage and percentage as it goes (optional).
 * @returns The stored file's name within `dir`.
 * @throws With `code: 'transcode_busy'`/`'transcode_failed'` if a MOV can't be converted now
 *   or at all, or the error from moving the file.
 */
async function storeVideoFile(dir: string, file: UploadedFile, type: OverlayVideoType, onProgress?: ProgressListener): Promise<string> {
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
 * @param file - The finished upload, kept on disk in the incoming folder (see `adoptChunkedUpload`).
 * @param details - The upload's detected format and, when the page sent one, its upload ID.
 * @returns The stored file's name within `dir`.
 * @throws Whatever {@link storeVideoFile} throws.
 */
async function storeWithProgress(
  streamer: DbStreamerEventSub,
  dir: string,
  file: UploadedFile,
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
 * Records a stored overlay video in the DB if it fits the streamer's storage cap, deleting the
 * file again if it doesn't or the DB insert fails. The cap is checked here, on the file as stored
 * (a MOV is already its much smaller WebM), not on the size the upload declared. Check and insert
 * run under {@link withStreamerQuota}, so two of the streamer's videos can't both fit at once.
 * @param streamerId - DB row ID of the owning streamer.
 * @param name - Display name for the video.
 * @param filename - The stored file's name within the streamer's folder.
 * @param fullPath - Absolute path of the stored file.
 * @returns Resolves once the video is recorded.
 * @throws With `code: 'storage_limit'` if the file would take the streamer over the cap, or an
 *   error if it can't be measured (missing included) or recorded. Either way the file is removed first.
 */
async function recordVideoWithinQuota(streamerId: number, name: string, filename: string, fullPath: string): Promise<void> {
  try {
    await withStreamerQuota(streamerId, async () => {
      const size = await videoFileSize({ folder: streamerFolder(streamerId), filename });
      // Gone already, or its real path is outside the overlay folder: there's nothing to record.
      if (size === null) throw new Error(`Stored overlay video ${filename} cannot be measured`);
      if (await exceedsStreamerStorage(streamerId, size)) {
        throw Object.assign(new Error('Overlay storage limit reached'), { code: 'storage_limit' });
      }
      await addVideo(streamerId, name, filename);
    });
  } catch (e) {
    await fs.promises.rm(fullPath, { force: true });
    throw e;
  }
}

/**
 * Stores an uploaded overlay video in the streamer's folder (see {@link storeVideoFile}) and
 * records it in the DB (see {@link recordVideoWithinQuota}), deleting the file again if it's over
 * the streamer's storage cap or the DB insert fails.
 * @param streamer - Owning streamer.
 * @param file - The finished upload, kept on disk in the incoming folder (see `adoptChunkedUpload`).
 * @param name - Display name for the video.
 * @param uploadId - The page's ID for this upload (`X-Upload-Id`), or null when it sent none.
 * @returns Resolves once the file is saved and recorded.
 * @throws With `code: 'invalid_path'`, `'invalid_file'`, `'transcode_busy'`, `'transcode_failed'`
 *   or `'storage_limit'` for a bad path, a non-video upload, a full conversion queue, a MOV that
 *   couldn't be converted or a stored file that would take the streamer over their storage cap.
 */
async function saveVideoFile(streamer: DbStreamerEventSub, file: UploadedFile, name: string, uploadId: string | null): Promise<void> {
  const dir = safeResolve(OVERLAY_FOLDER, String(streamer.id));
  if (!dir) throw Object.assign(new Error('Path traversal blocked'), { code: 'invalid_path' });
  const type = await detectUploadedVideoType(file);
  if (!type) throw Object.assign(new Error('Invalid file type'), { code: 'invalid_file' });
  await fs.promises.mkdir(dir, { recursive: true });
  const filename = await storeWithProgress(streamer, dir, file, { type, uploadId });
  await recordVideoWithinQuota(streamer.id, name, filename, path.join(dir, filename));
  log.info(`Overlay video uploaded for ${streamer.twitch_name}: ${filename}${type === 'mov' ? ' (converted from MOV)' : ''}`);
}

/**
 * Express middleware admitting a finished upload for processing only while fewer than
 * {@link MAX_CONCURRENT_OVERLAY_UPLOADS} are being processed; a further one is turned away with
 * `upload_busy` and its file removed. The slot is released once the response has been sent or
 * the connection closes, whichever comes first.
 * @param req - Express request carrying the finished upload in `req.file`.
 * @param res - Express response; redirected when the limit is reached.
 * @param next - Continues to the upload handler when the upload is admitted.
 * @returns Resolves once the upload is admitted or turned away.
 */
export async function limitConcurrentUploads(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (activeUploads >= MAX_CONCURRENT_OVERLAY_UPLOADS) {
    if (req.file) await discardUpload(req.file);
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

/** Redirects non-streamers before any chunked-upload route runs (see `makeRequireStreamerBeforeUpload`). */
const requireStreamerBeforeUpload = makeRequireStreamerBeforeUpload({
  notAStreamerRedirect: NOT_A_STREAMER_REDIRECT,
  basePath: '/overlay/settings',
  log,
  logLabel: 'Overlay video upload streamer check error:',
});

/**
 * Handles one finished overlay video upload: stores and records it, and redirects with the
 * outcome (see the chunked upload routes below for the redirect codes).
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
 * Runs {@link handleVideoUpload}, then makes sure nothing is left in the incoming folder: a
 * stored upload was moved out already, and anything else (rejected, failed) is removed here.
 * @param req - Express request carrying the upload in `req.file`.
 * @param res - Express response, redirected with the outcome.
 * @returns Resolves once the response has been sent and the upload cleaned up.
 */
async function handleVideoUploadAndCleanUp(req: Request, res: Response): Promise<void> {
  try {
    await handleVideoUpload(req, res);
  } finally {
    if (req.file) await discardUpload(req.file);
    await sweepStaleIncomingUploads();
  }
}

/** Chunked upload sessions for overlay videos, inside the incoming folder so finishing is a rename. */
const chunkedVideoStore = new ChunkedUploadStore({
  dir: path.join(INCOMING_DIR, 'chunked'),
  maxBytes: MAX_FILE_BYTES,
  // Bounds the disk unfinished overlay uploads can take across all streamers (each up to the size limit).
  maxSessions: MAX_CONCURRENT_OVERLAY_UPLOADS,
});

/**
 * Turns an upload away before any of it is sent: with `upload_busy` while the most finished
 * uploads are already being processed (completion checks again, for races), or a declared MOV
 * with `transcode_busy` while the conversion queue is full, or with `storage_limit` when the
 * streamer's stored videos are already at or over their cap. The declared size isn't held against
 * the cap here: a MOV is stored as a much smaller WebM, so completion checks the stored file.
 * @param declared - The upload's declared name and type.
 * @param req - Express request, for the session user whose streamer record is checked.
 * @returns `upload_busy`, `transcode_busy`, `storage_limit`, or null to let the upload start.
 */
async function checkChunkedVideoStart(declared: ChunkedUploadDeclaration, req: Request): Promise<string | null> {
  // Turned away now rather than at completion, so the user doesn't send the whole file first.
  if (activeUploads >= MAX_CONCURRENT_OVERLAY_UPLOADS) return 'upload_busy';
  if (declaresMov(declared.name, declared.type) && isWebmTranscodeQueueFull()) return 'transcode_busy';
  // The guards already turned non-streamers away; one deleted since then is refused at completion.
  const streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
  return streamer && await isStreamerStorageFull(streamer.id) ? 'storage_limit' : null;
}

/**
 * Chunked, resumable overlay video uploads under `/overlay/settings/videos/upload/…` (see
 * `mountChunkedUploadRoutes`): a video file (webm/mp4/mov, validated by magic bytes; a mov is
 * converted to webm) for the requesting streamer. The complete request's `X-Upload-Id` header
 * (32 lowercase hex characters) lets the page poll a MOV's conversion progress at
 * `GET /overlay/settings/videos/progress/:uploadId` while it runs. CSRF and the streamer check
 * guard every route; the page sends the token in an X-CSRF-Token header. Completing redirects to
 * `/overlay/settings?success=video_uploaded`, or `?error=<code>`: `not_a_streamer`,
 * `invalid_file` (failed magic-byte validation), `transcode_failed`/`transcode_busy` (a MOV
 * couldn't be converted, now or at all), `upload_busy` (too many being processed),
 * `storage_limit` (the streamer's stored videos are at their cap, or this one would take them
 * over it), `invalid_path` or `upload_failed`. The finished file is always removed from the incoming folder afterwards.
 */
mountChunkedUploadRoutes(router, {
  path: '/settings/videos/upload',
  store: chunkedVideoStore,
  guards: [requireAuth, csrfProtection, requireStreamerBeforeUpload],
  field: 'video',
  checkStart: checkChunkedVideoStart,
  toFile: adoptChunkedUpload,
  complete: [limitConcurrentUploads, handleVideoUploadAndCleanUp],
  basePath: '/overlay/settings',
  log,
  // Leftovers in the incoming folder (e.g. from a restart mid-upload) are swept even when no
  // further upload completes.
  onSweep: sweepStaleIncomingUploads,
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
