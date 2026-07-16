import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { setAlertImage, setAlertSound } from '../../db';
import type { AlertEventType, DbStreamerEventSub } from '../../db';
import { ALERT_ASSETS_FOLDER, ALERT_MAX_IMAGE_MB, ALERT_MAX_SOUND_MB } from '../../shared/config';
import { safeResolve } from '../../shared/pathUtils';
import { logAndRedirectError, requireStreamer, createMulterErrorRedirectHandler } from './shared';
import { detectAudioType } from './sfxFileUpload';
import { NOT_A_STREAMER_REDIRECT, parseEventType } from './alertsShared';

const log = createLogger('AlertsAdmin');
export const router = Router();

/** Maximum upload sizes in megabytes, passed to templates to avoid direct process.env access in EJS. */
export const MAX_IMAGE_MB = ALERT_MAX_IMAGE_MB;
export const MAX_SOUND_MB = ALERT_MAX_SOUND_MB;

const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024 } });
const soundUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SOUND_MB * 1024 * 1024 } });

/**
 * Detect an image file's type from its magic bytes, independent of the client-supplied MIME
 * type. Deliberately excludes SVG (script/XSS risk if ever reflected back to a browser source).
 * - PNG: `\x89PNG\r\n\x1a\n` signature
 * - GIF: `GIF87a` or `GIF89a` signature
 * - JPEG: `\xFF\xD8\xFF` signature
 * - WEBP: `RIFF....WEBP` container
 */
export function detectImageType(buf: Buffer): 'png' | 'gif' | 'jpeg' | 'webp' | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buf.subarray(0, 6).equals(Buffer.from('GIF87a', 'ascii')) || buf.subarray(0, 6).equals(Buffer.from('GIF89a', 'ascii'))) {
    return 'gif';
  }
  if (buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'jpeg';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).equals(Buffer.from('RIFF', 'ascii')) &&
    buf.subarray(8, 12).equals(Buffer.from('WEBP', 'ascii'))
  ) {
    return 'webp';
  }
  return null;
}

/**
 * Removes a previously-stored asset file, tolerating it already being gone. Always called after
 * the DB mutation (`setAsset`) that orphaned it has already committed, so a failure here is
 * logged and swallowed rather than thrown — it must never turn an already-successful config
 * change into a failure response; it just leaves a stale file on disk for later cleanup.
 */
async function removeOldAsset(streamerId: number, filename: string | null): Promise<void> {
  if (!filename) return;
  const fullPath = safeResolve(ALERT_ASSETS_FOLDER, String(streamerId), filename);
  if (!fullPath) return;
  try {
    await fs.promises.rm(fullPath, { force: true });
  } catch (err) {
    log.error(`Failed to remove orphaned alert asset ${fullPath}:`, err);
  }
}

/** Persists a new asset filename for a streamer's alert config row (`setAlertImage`/`setAlertSound`). */
type AssetSetter = (streamerId: number, eventType: AlertEventType, filename: string | null) => Promise<string | null>;

/** Options for {@link saveUploadedAsset}, bundled to keep the function to a single parameter. */
interface SaveUploadedAssetOptions {
  /** The requesting streamer, already verified to own the target config row. */
  streamer: DbStreamerEventSub;
  /** Which alert event type the upload is for. */
  eventType: AlertEventType;
  /** The uploaded file from Multer, or undefined if none was attached. */
  file: Express.Multer.File | undefined;
  /** Magic-byte detector returning the file's extension, or null if unrecognised. */
  detect: (buf: Buffer) => string | null;
  /** DB setter (`setAlertImage`/`setAlertSound`) to persist the new filename. */
  setAsset: AssetSetter;
  /** `'image'` or `'sound'`, used for the success code and log message. */
  assetLabel: 'image' | 'sound';
}

/**
 * Validates (via `detect`), writes, and persists an uploaded asset file (image or sound) for
 * one of a streamer's alert event types, removing any previously-uploaded file of the same kind
 * on disk. Shared by the image and sound upload routes below, which differ only in their magic-byte
 * detector, DB setter, and multer field/label names.
 * @param options - See {@link SaveUploadedAssetOptions}.
 * @returns An error code to redirect with, or a success code to redirect with.
 */
async function saveUploadedAsset(
  options: SaveUploadedAssetOptions,
): Promise<{ errorCode: string } | { successCode: string }> {
  const { streamer, eventType, file, detect, setAsset, assetLabel } = options;

  if (!file) return { errorCode: 'invalid_file' };
  const ext = detect(file.buffer);
  if (!ext) return { errorCode: 'invalid_file' };

  const dir = safeResolve(ALERT_ASSETS_FOLDER, String(streamer.id));
  if (!dir) return { errorCode: 'invalid_path' };

  const filename = `${eventType}-${randomUUID()}.${ext}`;
  await fs.promises.mkdir(dir, { recursive: true });
  const fullPath = safeResolve(ALERT_ASSETS_FOLDER, String(streamer.id), filename);
  if (!fullPath) return { errorCode: 'invalid_path' };
  await fs.promises.writeFile(fullPath, file.buffer);

  let previous: string | null;
  try {
    previous = await setAsset(streamer.id, eventType, filename);
  } catch (err) {
    await fs.promises.rm(fullPath, { force: true });
    throw err;
  }
  await removeOldAsset(streamer.id, previous);

  log.info(`Alert ${assetLabel} uploaded for ${streamer.twitch_name} (${eventType}): ${filename}`);
  return { successCode: `${assetLabel}_uploaded` };
}

/** Clears a streamer's asset for one alert event type, removing both the DB reference and the file on disk. */
async function deleteAsset(streamerId: number, eventType: AlertEventType, setAsset: AssetSetter): Promise<void> {
  const previous = await setAsset(streamerId, eventType, null);
  await removeOldAsset(streamerId, previous);
}

/**
 * Builds the POST /settings/:eventType/<image|sound> route handler for one asset kind: verifies
 * the requester is a streamer, validates `:eventType`, delegates to {@link saveUploadedAsset},
 * and redirects based on the result. Shared by the image and sound upload routes, which
 * previously differed only in their detector/setter/field name — this collapses that remaining
 * boilerplate down to a single factory call per route.
 * @param detect - Magic-byte detector for this asset kind.
 * @param setAsset - DB setter (`setAlertImage`/`setAlertSound`) for this asset kind.
 * @param assetLabel - `'image'` or `'sound'`, used for error/log labelling.
 * @returns An Express route handler for the upload route.
 */
function makeUploadHandler(
  detect: (buf: Buffer) => string | null,
  setAsset: AssetSetter,
  assetLabel: 'image' | 'sound',
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
      if (!streamer) return;

      const eventType = parseEventType(req.params.eventType);
      if (!eventType) return res.redirect('/alerts/settings?error=invalid_event_type');

      const result = await saveUploadedAsset({ streamer, eventType, file: req.file, detect, setAsset, assetLabel });
      if ('errorCode' in result) return res.redirect(`/alerts/settings?error=${result.errorCode}`);
      res.redirect(`/alerts/settings?success=${result.successCode}`);
    } catch (err) {
      logAndRedirectError({ res, log, logLabel: `Alert ${assetLabel} upload error:`, err, basePath: '/alerts/settings', errorCode: 'upload_failed' });
    }
  };
}

/**
 * Builds the POST /settings/:eventType/<image|sound>/delete route handler for one asset kind:
 * verifies the requester is a streamer, validates `:eventType`, and delegates to
 * {@link deleteAsset}. Shared by the image and sound delete routes.
 * @param setAsset - DB setter (`setAlertImage`/`setAlertSound`) for this asset kind.
 * @param assetLabel - `'image'` or `'sound'`, used for the success code and log labelling.
 * @returns An Express route handler for the delete route.
 */
function makeDeleteHandler(
  setAsset: AssetSetter,
  assetLabel: 'image' | 'sound',
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
      if (!streamer) return;

      const eventType = parseEventType(req.params.eventType);
      if (!eventType) return res.redirect('/alerts/settings?error=invalid_event_type');

      await deleteAsset(streamer.id, eventType, setAsset);
      res.redirect(`/alerts/settings?success=${assetLabel}_deleted`);
    } catch (err) {
      logAndRedirectError({ res, log, logLabel: `Alert ${assetLabel} delete error:`, err, basePath: '/alerts/settings', errorCode: 'delete_failed' });
    }
  };
}

/**
 * Translate a Multer error into a user-facing redirect. An oversized file (`LIMIT_FILE_SIZE`)
 * gets the `file_too_large` code; any other error falls back to `upload_failed`.
 */
const handleUploadError = createMulterErrorRedirectHandler('/alerts/settings', log, 'Alert upload middleware error:');

/** Express middleware running Multer's single-file (`image`) parser, redirecting on error. */
function uploadImage(req: Request, res: Response, next: NextFunction): void {
  imageUpload.single('image')(req, res, (err: unknown) => {
    if (handleUploadError(err, res)) return;
    next();
  });
}

/** Express middleware running Multer's single-file (`sound`) parser, redirecting on error. */
function uploadSound(req: Request, res: Response, next: NextFunction): void {
  soundUpload.single('sound')(req, res, (err: unknown) => {
    if (handleUploadError(err, res)) return;
    next();
  });
}

/**
 * POST /alerts/settings/:eventType/image — uploads an image/GIF (magic-byte validated) for one
 * of the requesting streamer's alert event types, replacing (and removing on disk) any
 * previously-uploaded image. csrfProtection runs BEFORE uploadImage so a bad token is rejected
 * before Multer buffers the file; the client sends the token in an X-CSRF-Token header.
 * @param req - Express request; reads the `eventType` route param and the `image` file.
 * @param res - Express response; redirects to `/alerts/settings?success=image_uploaded` on
 *   success, or to `/alerts/settings?error=<code>` if the requester isn't a streamer
 *   (`not_a_streamer`), `eventType` is invalid (`invalid_event_type`), no file was uploaded or
 *   it failed magic-byte validation (`invalid_file`), the resolved storage path is unsafe
 *   (`invalid_path`), the file exceeds the size limit (`file_too_large`), or saving fails
 *   (`upload_failed`).
 */
router.post('/settings/:eventType/image', requireAuth, csrfProtection, uploadImage, makeUploadHandler(detectImageType, setAlertImage, 'image'));

/**
 * POST /alerts/settings/:eventType/sound — uploads a sound (magic-byte validated, via the
 * shared `detectAudioType` used by SFX uploads) for one of the requesting streamer's alert
 * event types, replacing (and removing on disk) any previously-uploaded sound.
 * @param req - Express request; reads the `eventType` route param and the `sound` file.
 * @param res - Express response; redirects to `/alerts/settings?success=sound_uploaded` on
 *   success, or to `/alerts/settings?error=<code>` with the same error codes as the image
 *   upload route above.
 */
router.post('/settings/:eventType/sound', requireAuth, csrfProtection, uploadSound, makeUploadHandler(detectAudioType, setAlertSound, 'sound'));

/**
 * POST /alerts/settings/:eventType/image/delete — removes the requesting streamer's uploaded
 * image for one alert event type, both the DB reference and the file on disk.
 * @param req - Express request; reads the `eventType` route param.
 * @param res - Express response; redirects to `/alerts/settings?success=image_deleted` on
 *   success, or to `/alerts/settings?error=<code>` if the requester isn't a streamer
 *   (`not_a_streamer`), `eventType` is invalid (`invalid_event_type`), or the delete fails
 *   (`delete_failed`).
 */
router.post('/settings/:eventType/image/delete', requireAuth, csrfProtection, makeDeleteHandler(setAlertImage, 'image'));

/**
 * POST /alerts/settings/:eventType/sound/delete — removes the requesting streamer's uploaded
 * sound for one alert event type, both the DB reference and the file on disk.
 * @param req - Express request; reads the `eventType` route param.
 * @param res - Express response; redirects to `/alerts/settings?success=sound_deleted` on
 *   success, or to `/alerts/settings?error=<code>` with the same error codes as the image
 *   delete route above.
 */
router.post('/settings/:eventType/sound/delete', requireAuth, csrfProtection, makeDeleteHandler(setAlertSound, 'sound'));

export default router;
