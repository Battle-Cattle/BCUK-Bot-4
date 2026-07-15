import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { ALERT_EVENT_TYPES, saveAlertConfig, setAlertImage, setAlertSound } from '../../db';
import type { AlertEventType } from '../../db';
import { ALERT_ASSETS_FOLDER, ALERT_MAX_IMAGE_MB, ALERT_MAX_SOUND_MB } from '../../shared/config';
import { safeResolve } from '../../shared/pathUtils';
import {
  logAndRedirectError, requireStreamer, parseCheckboxField, createMulterErrorRedirectHandler,
} from './shared';
import { detectAudioType } from './sfxFileUpload';
import { pushAlertEvent } from './alertsOverlaySource';

const log = createLogger('AlertsAdmin');
export const router = Router();

/** Redirect target used when the requester isn't a streamer, scoped to the alerts admin page. */
const NOT_A_STREAMER_REDIRECT = '/alerts/settings?error=not_a_streamer';

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
 * Validates an `:eventType` route param against the fixed set of alert event types.
 * Rejects a repeated field (arriving as an array), consistent with `parsePositiveIntId`.
 */
function parseEventType(value: string | string[]): AlertEventType | null {
  if (Array.isArray(value)) return null;
  return (ALERT_EVENT_TYPES as readonly string[]).includes(value) ? (value as AlertEventType) : null;
}

/** Removes a previously-stored asset file, tolerating it already being gone. */
async function removeOldAsset(streamerId: number, filename: string | null): Promise<void> {
  if (!filename) return;
  const fullPath = safeResolve(ALERT_ASSETS_FOLDER, String(streamerId), filename);
  if (!fullPath) return;
  await fs.promises.rm(fullPath, { force: true });
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
router.post('/settings/:eventType/image', requireAuth, csrfProtection, uploadImage, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const eventType = parseEventType(req.params.eventType);
    if (!eventType) return res.redirect('/alerts/settings?error=invalid_event_type');
    if (!req.file) return res.redirect('/alerts/settings?error=invalid_file');

    const ext = detectImageType(req.file.buffer);
    if (!ext) return res.redirect('/alerts/settings?error=invalid_file');

    const dir = safeResolve(ALERT_ASSETS_FOLDER, String(streamer.id));
    if (!dir) return res.redirect('/alerts/settings?error=invalid_path');

    const filename = `${eventType}-${randomUUID()}.${ext}`;
    await fs.promises.mkdir(dir, { recursive: true });
    const fullPath = safeResolve(ALERT_ASSETS_FOLDER, String(streamer.id), filename);
    if (!fullPath) return res.redirect('/alerts/settings?error=invalid_path');
    await fs.promises.writeFile(fullPath, req.file.buffer);

    let previous: string | null;
    try {
      previous = await setAlertImage(streamer.id, eventType, filename);
    } catch (err) {
      await fs.promises.rm(fullPath, { force: true });
      throw err;
    }
    await removeOldAsset(streamer.id, previous);

    log.info(`Alert image uploaded for ${streamer.twitch_name} (${eventType}): ${filename}`);
    res.redirect('/alerts/settings?success=image_uploaded');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Alert image upload error:', err, basePath: '/alerts/settings', errorCode: 'upload_failed' });
  }
});

/**
 * POST /alerts/settings/:eventType/sound — uploads a sound (magic-byte validated, via the
 * shared `detectAudioType` used by SFX uploads) for one of the requesting streamer's alert
 * event types, replacing (and removing on disk) any previously-uploaded sound.
 * @param req - Express request; reads the `eventType` route param and the `sound` file.
 * @param res - Express response; redirects to `/alerts/settings?success=sound_uploaded` on
 *   success, or to `/alerts/settings?error=<code>` with the same error codes as the image
 *   upload route above.
 */
router.post('/settings/:eventType/sound', requireAuth, csrfProtection, uploadSound, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const eventType = parseEventType(req.params.eventType);
    if (!eventType) return res.redirect('/alerts/settings?error=invalid_event_type');
    if (!req.file) return res.redirect('/alerts/settings?error=invalid_file');

    const ext = detectAudioType(req.file.buffer);
    if (!ext) return res.redirect('/alerts/settings?error=invalid_file');

    const dir = safeResolve(ALERT_ASSETS_FOLDER, String(streamer.id));
    if (!dir) return res.redirect('/alerts/settings?error=invalid_path');

    const filename = `${eventType}-${randomUUID()}.${ext}`;
    await fs.promises.mkdir(dir, { recursive: true });
    const fullPath = safeResolve(ALERT_ASSETS_FOLDER, String(streamer.id), filename);
    if (!fullPath) return res.redirect('/alerts/settings?error=invalid_path');
    await fs.promises.writeFile(fullPath, req.file.buffer);

    let previous: string | null;
    try {
      previous = await setAlertSound(streamer.id, eventType, filename);
    } catch (err) {
      await fs.promises.rm(fullPath, { force: true });
      throw err;
    }
    await removeOldAsset(streamer.id, previous);

    log.info(`Alert sound uploaded for ${streamer.twitch_name} (${eventType}): ${filename}`);
    res.redirect('/alerts/settings?success=sound_uploaded');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Alert sound upload error:', err, basePath: '/alerts/settings', errorCode: 'upload_failed' });
  }
});

/**
 * POST /alerts/settings/:eventType/image/delete — removes the requesting streamer's uploaded
 * image for one alert event type, both the DB reference and the file on disk.
 * @param req - Express request; reads the `eventType` route param.
 * @param res - Express response; redirects to `/alerts/settings?success=image_deleted` on
 *   success, or to `/alerts/settings?error=<code>` if the requester isn't a streamer
 *   (`not_a_streamer`), `eventType` is invalid (`invalid_event_type`), or the delete fails
 *   (`delete_failed`).
 */
router.post('/settings/:eventType/image/delete', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const eventType = parseEventType(req.params.eventType);
    if (!eventType) return res.redirect('/alerts/settings?error=invalid_event_type');

    const previous = await setAlertImage(streamer.id, eventType, null);
    await removeOldAsset(streamer.id, previous);

    res.redirect('/alerts/settings?success=image_deleted');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Alert image delete error:', err, basePath: '/alerts/settings', errorCode: 'delete_failed' });
  }
});

/**
 * POST /alerts/settings/:eventType/sound/delete — removes the requesting streamer's uploaded
 * sound for one alert event type, both the DB reference and the file on disk.
 * @param req - Express request; reads the `eventType` route param.
 * @param res - Express response; redirects to `/alerts/settings?success=sound_deleted` on
 *   success, or to `/alerts/settings?error=<code>` with the same error codes as the image
 *   delete route above.
 */
router.post('/settings/:eventType/sound/delete', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const eventType = parseEventType(req.params.eventType);
    if (!eventType) return res.redirect('/alerts/settings?error=invalid_event_type');

    const previous = await setAlertSound(streamer.id, eventType, null);
    await removeOldAsset(streamer.id, previous);

    res.redirect('/alerts/settings?success=sound_deleted');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Alert sound delete error:', err, basePath: '/alerts/settings', errorCode: 'delete_failed' });
  }
});

/**
 * POST /alerts/settings/:eventType — saves the non-file fields (enable flag, message template,
 * display duration) of one of the requesting streamer's alert configs.
 * @param req - Express request; reads the `eventType` route param and `enabled`,
 *   `message_template`, `duration_ms` fields from `req.body`.
 * @param res - Express response; redirects to `/alerts/settings?success=config_saved` on
 *   success, or to `/alerts/settings?error=<code>` if the requester isn't a streamer
 *   (`not_a_streamer`), `eventType` is invalid (`invalid_event_type`), the message template is
 *   blank (`invalid_message`), or saving fails (`save_failed`).
 */
router.post('/settings/:eventType', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const eventType = parseEventType(req.params.eventType);
    if (!eventType) return res.redirect('/alerts/settings?error=invalid_event_type');

    const messageTemplate = (typeof req.body?.message_template === 'string' ? req.body.message_template : '').trim().slice(0, 500);
    if (messageTemplate.length === 0) return res.redirect('/alerts/settings?error=invalid_message');

    const durationRaw = Number(req.body?.duration_ms);
    const durationMs = Number.isInteger(durationRaw) ? Math.min(60_000, Math.max(1000, durationRaw)) : 6000;

    await saveAlertConfig(streamer.id, eventType, {
      enabled: parseCheckboxField(req.body?.enabled),
      message_template: messageTemplate,
      duration_ms: durationMs,
    });

    res.redirect('/alerts/settings?success=config_saved');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Alert config save error:', err, basePath: '/alerts/settings', errorCode: 'save_failed' });
  }
});

/**
 * POST /alerts/settings/:eventType/test — pushes a synthetic alert for one of the requesting
 * streamer's event types through their alerts-overlay SSE stream, so they can preview it live
 * in OBS without waiting for a real Twitch event.
 * @param req - Express request; reads the `eventType` route param.
 * @param res - Express response; redirects to `/alerts/settings?success=test_sent` on success,
 *   or to `/alerts/settings?error=<code>` if the requester isn't a streamer
 *   (`not_a_streamer`), `eventType` is invalid (`invalid_event_type`), or they have no Twitch
 *   channel connected to push to (`not_a_streamer`).
 */
router.post('/settings/:eventType/test', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const eventType = parseEventType(req.params.eventType);
    if (!eventType) return res.redirect('/alerts/settings?error=invalid_event_type');
    if (!streamer.twitch_name) return res.redirect(NOT_A_STREAMER_REDIRECT);

    pushAlertEvent(streamer.twitch_name.toLowerCase(), {
      type: eventType,
      message: `Test alert — ${eventType}`,
      imageUrl: null,
      soundUrl: null,
      durationMs: 6000,
    });

    res.redirect('/alerts/settings?success=test_sent');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Alert test-send error:', err, basePath: '/alerts/settings', errorCode: 'save_failed' });
  }
});

export default router;
