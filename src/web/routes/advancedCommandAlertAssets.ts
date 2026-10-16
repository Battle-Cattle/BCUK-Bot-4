// Image/sound uploads for an advanced command's alert, stored beside the event alerts' assets in
// `ALERT_ASSETS_FOLDER/<streamer_id>/` and served by the same `GET /alerts/assets/...` route. The
// filename is generated here and written to the DB only by these routes, so a form can't point
// an alert at an arbitrary file.
import { createLogger } from '../../shared/logger';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { setAdvancedCommandAlertAsset } from '../../db';
import { ALERT_ASSETS_FOLDER, ALERT_MAX_IMAGE_MB, ALERT_MAX_SOUND_MB } from '../../shared/config';
import { safeResolve } from '../../shared/pathUtils';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { requireStreamer } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';
import { parsePositiveIntId } from './validation';
import {
  createMulterErrorRedirectHandler, makeRequireStreamerBeforeUpload, makeUploadMiddleware, writeFileOrCleanup,
} from './uploadMiddleware';
import { detectAudioType, detectImageType } from './uploadFileTypes';
import { BASE_PATH, NOT_A_STREAMER_REDIRECT } from './advancedCommandPaths';

const log = createLogger('Web');
export const router = Router();

type AssetKind = 'image' | 'sound';

const DETECTORS: Record<AssetKind, (buf: Buffer) => string | null> = { image: detectImageType, sound: detectAudioType };
/** A stored asset filename as {@link storeAsset} generates it — anything else is never deleted. */
const STORED_FILENAME = /^[\w-]+\.(png|gif|jpeg|webp|mp3|ogg|wav)$/;

/**
 * Deletes alert asset files from a streamer's folder, tolerating ones already gone. Called after
 * the DB change that orphaned them has committed, so a failure is logged, never thrown.
 * @param streamerId - The owning streamer's id.
 * @param filenames - Stored filenames to delete.
 */
export async function removeAlertAssetFiles(streamerId: number, filenames: string[]): Promise<void> {
  for (const filename of filenames) {
    // Filenames only ever come from the DB, but a path separator must never let one reach outside
    // this streamer's own folder.
    const fullPath = STORED_FILENAME.test(filename) ? safeResolve(ALERT_ASSETS_FOLDER, String(streamerId), filename) : null;
    if (!fullPath) continue;
    try {
      await fs.promises.rm(fullPath, { force: true });
    } catch (err) {
      log.error(`Failed to remove orphaned advanced command asset ${fullPath}:`, err);
    }
  }
}

/**
 * Validates, stores and records an uploaded asset for a command's alert, deleting the one it
 * replaces.
 * @param streamerId - The owning streamer's id.
 * @param commandId - The command's id.
 * @param kind - `'image'` or `'sound'`.
 * @param file - The uploaded file, if any.
 * @returns A `?error=` code, or null on success.
 */
async function storeAsset(streamerId: number, commandId: number, kind: AssetKind, file: Express.Multer.File | undefined): Promise<string | null> {
  const ext = file ? DETECTORS[kind](file.buffer) : null;
  if (!file || !ext) return 'invalid_file';
  const filename = `command-${commandId}-${randomUUID()}.${ext}`;
  const dir = safeResolve(ALERT_ASSETS_FOLDER, String(streamerId));
  const fullPath = safeResolve(ALERT_ASSETS_FOLDER, String(streamerId), filename);
  if (!dir || !fullPath) return 'invalid_path';
  await fs.promises.mkdir(dir, { recursive: true });
  await writeFileOrCleanup(fullPath, file.buffer, log);

  let result;
  try {
    result = await setAdvancedCommandAlertAsset(streamerId, commandId, kind, filename);
  } catch (err) {
    await fs.promises.rm(fullPath, { force: true });
    throw err;
  }
  if (!result) {
    await fs.promises.rm(fullPath, { force: true });
    return 'no_alert';
  }
  await removeAlertAssetFiles(streamerId, result.previous ? [result.previous] : []);
  return null;
}

/**
 * Builds the upload route handler for one asset kind.
 * @param kind - `'image'` or `'sound'`.
 * @returns The Express handler; redirects with `?success=<kind>_uploaded` or `?error=<code>`
 *   (`no_alert` when the command has no alert yet — save one first).
 */
function uploadHandler(kind: AssetKind) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
      if (!streamer) return;
      const commandId = parsePositiveIntId(req.params.id);
      const error = commandId === null ? 'not_found' : await storeAsset(streamer.id, commandId, kind, req.file);
      res.redirect(error ? `${BASE_PATH}?error=${error}` : `${BASE_PATH}?success=${kind}_uploaded`);
    } catch (err) {
      logAndRedirectError({ res, log, logLabel: `Advanced command ${kind} upload error:`, err, basePath: BASE_PATH, errorCode: 'upload_failed' });
    }
  };
}

/**
 * Builds the delete route handler for one asset kind.
 * @param kind - `'image'` or `'sound'`.
 * @returns The Express handler; redirects with `?success=<kind>_deleted` or `?error=<code>`.
 */
function deleteHandler(kind: AssetKind) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
      if (!streamer) return;
      const commandId = parsePositiveIntId(req.params.id);
      const result = commandId === null ? null : await setAdvancedCommandAlertAsset(streamer.id, commandId, kind, null);
      if (!result) return res.redirect(`${BASE_PATH}?error=no_alert`);
      await removeAlertAssetFiles(streamer.id, result.previous ? [result.previous] : []);
      res.redirect(`${BASE_PATH}?success=${kind}_deleted`);
    } catch (err) {
      logAndRedirectError({ res, log, logLabel: `Advanced command ${kind} delete error:`, err, basePath: BASE_PATH, errorCode: 'save_failed' });
    }
  };
}

const handleUploadError = createMulterErrorRedirectHandler(BASE_PATH, log, 'Advanced command upload middleware error:');
const requireStreamerBeforeUpload = makeRequireStreamerBeforeUpload({
  notAStreamerRedirect: NOT_A_STREAMER_REDIRECT, basePath: BASE_PATH, log, logLabel: 'Advanced command upload streamer check error:',
});
const uploadImage = makeUploadMiddleware(
  multer({ storage: multer.memoryStorage(), limits: { fileSize: ALERT_MAX_IMAGE_MB * 1024 * 1024 } }), 'image', handleUploadError,
);
const uploadSound = makeUploadMiddleware(
  multer({ storage: multer.memoryStorage(), limits: { fileSize: ALERT_MAX_SOUND_MB * 1024 * 1024 } }), 'sound', handleUploadError,
);

/**
 * POST /advanced-commands/:id/alert/image — uploads an image/GIF (magic-byte validated) for a
 * command's alert. CSRF and the streamer check run before Multer buffers the file; the page sends
 * the token in an X-CSRF-Token header.
 */
router.post(`${BASE_PATH}/:id/alert/image`, requireAuth, csrfProtection, requireStreamerBeforeUpload, uploadImage, uploadHandler('image'));

/** POST /advanced-commands/:id/alert/sound — uploads a sound for a command's alert; as for the image. */
router.post(`${BASE_PATH}/:id/alert/sound`, requireAuth, csrfProtection, requireStreamerBeforeUpload, uploadSound, uploadHandler('sound'));

/** POST /advanced-commands/:id/alert/image/delete — removes a command's alert image (DB and disk). */
router.post(`${BASE_PATH}/:id/alert/image/delete`, requireAuth, csrfProtection, deleteHandler('image'));

/** POST /advanced-commands/:id/alert/sound/delete — removes a command's alert sound (DB and disk). */
router.post(`${BASE_PATH}/:id/alert/sound/delete`, requireAuth, csrfProtection, deleteHandler('sound'));
