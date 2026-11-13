import path from 'path';
import { Router, type Request, type Response } from 'express';
import { createLogger } from '../../shared/logger';
import { csrfProtection } from '../csrf';
import { getSessionUser } from '../session';
import { ChunkedUploadStore } from '../chunkedUploadStore';
import { OVERLAY_MAX_FILE_MB } from '../../shared/config';
import { mountChunkedUploadRoutes } from './chunkedUploadRoutes';
import { logAndRedirectError } from './errorHandling';
import { isWebmTranscodeQueueFull } from './overlayVideoTranscode';
import { parseUploadId, claimConversionProgress, setConversionProgress, releaseConversionProgress } from './overlayConversionProgress';
import {
  adoptChunkedUpload, INCOMING_DIR, detectUploadedVideoType, placeUpload, discardUpload, sweepStaleIncomingUploads,
} from './overlayUploadStorage';
import { storeSharedVideo, recordSharedVideo } from './sharedOverlayVideoStorage';
import { createUploadSlots } from './uploadSlots';
import { broadcastSharedVideoList } from './sharedOverlaySource';
import { SHARED_SETTINGS_PATH, SHARED_PROGRESS_KEY } from './sharedOverlayAdminShared';

// Chunked, resumable uploads of shared overlay videos (#917). Every upload, whatever its type,
// is converted to WebM. Mounted by sharedOverlayAdmin.ts behind the Manager gate.

const log = createLogger('SharedOverlayAdminUpload');
export const router = Router();

/** Most shared uploads processed (and unfinished) at once, the same cap as streamer overlay uploads. */
const MAX_CONCURRENT_OVERLAY_UPLOADS = 3;

const MAX_FILE_BYTES = OVERLAY_MAX_FILE_MB * 1024 * 1024;

/** Slots for shared-video uploads being completed (checked, converted, stored), held until processing ends. */
const uploadSlots = createUploadSlots(MAX_CONCURRENT_OVERLAY_UPLOADS, `${SHARED_SETTINGS_PATH}?error=upload_busy`);

/** Error codes the upload completion reports as themselves. */
const UPLOAD_ERROR_CODES = new Set(['invalid_file', 'transcode_failed', 'transcode_busy']);

const chunkedStore = new ChunkedUploadStore({
  dir: path.join(INCOMING_DIR, 'chunked-shared'),
  maxBytes: MAX_FILE_BYTES,
  maxSessions: MAX_CONCURRENT_OVERLAY_UPLOADS,
});

/**
 * Turns an upload away before any of it is sent while too many are being processed or the
 * conversion queue is full (every shared upload is converted). These are hints so a whole file
 * isn't sent only to be refused; nothing is reserved, and completion checks again.
 * @returns `upload_busy`, `transcode_busy`, or null to let the upload start.
 */
function checkStart(): string | null {
  if (uploadSlots.isFull()) return 'upload_busy';
  return isWebmTranscodeQueueFull() ? 'transcode_busy' : null;
}

/**
 * Converts and records one finished upload, publishing conversion progress under `uploadId`.
 * @param req - Express request with the upload in `req.file`.
 * @param name - Display name for the video.
 * @returns Resolves once the video is stored and recorded.
 * @throws `invalid_file`, `transcode_busy` or `transcode_failed` coded errors, or a DB/filesystem error.
 */
async function convertAndRecord(req: Request, name: string): Promise<void> {
  const file = req.file!; // caller checked req.file
  if (!await detectUploadedVideoType(file)) throw Object.assign(new Error('Invalid file type'), { code: 'invalid_file' });
  const uploadId = parseUploadId(req.get('x-upload-id'));
  const owner = uploadId ? claimConversionProgress(SHARED_PROGRESS_KEY, uploadId) : null;
  try {
    const filename = await storeSharedVideo(
      (sourcePath) => placeUpload(file, sourcePath),
      uploadId && owner ? (progress) => setConversionProgress(SHARED_PROGRESS_KEY, uploadId, owner, progress) : undefined,
    );
    await recordSharedVideo(name, filename, getSessionUser(req).discordId);
    log.info(`Shared overlay video uploaded by ${getSessionUser(req).discordId}: ${filename}`);
  } finally {
    if (uploadId && owner) releaseConversionProgress(SHARED_PROGRESS_KEY, uploadId, owner);
  }
}

/**
 * Handles one finished shared video upload: converts and records it, tells connected overlays the
 * new list, and redirects with the outcome. Always removes what is left of the upload afterwards.
 * @param req - Express request; reads `name` and the `video` file.
 * @param res - Express response, redirected to the shared settings page.
 * @returns Resolves once the response has been sent.
 */
async function handleSharedUpload(req: Request, res: Response): Promise<void> {
  try {
    if (!req.file) return res.redirect(`${SHARED_SETTINGS_PATH}?error=invalid_file`);
    const name = (typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '') || req.file.originalname.trim().slice(0, 100);
    await convertAndRecord(req, name);
    await broadcastSharedVideoList().catch((err: unknown) => log.error('Failed to broadcast shared video list:', err));
    res.redirect(`${SHARED_SETTINGS_PATH}?success=video_uploaded`);
  } catch (err: unknown) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code && UPLOAD_ERROR_CODES.has(code)) return res.redirect(`${SHARED_SETTINGS_PATH}?error=${code}`);
    logAndRedirectError({ res, log, logLabel: 'Shared video upload error:', err, basePath: SHARED_SETTINGS_PATH, errorCode: 'upload_failed' });
  } finally {
    if (req.file) await discardUpload(req.file);
    await sweepStaleIncomingUploads();
  }
}

/**
 * Chunked upload routes under `/upload/…` (see `mountChunkedUploadRoutes`). The parent router
 * has already run the Manager gate; CSRF guards every route.
 */
mountChunkedUploadRoutes(router, {
  path: '/upload',
  store: chunkedStore,
  guards: [csrfProtection],
  field: 'video',
  checkStart,
  toFile: adoptChunkedUpload,
  complete: [uploadSlots.admit(handleSharedUpload)],
  basePath: SHARED_SETTINGS_PATH,
  log,
  onSweep: sweepStaleIncomingUploads,
});
