import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { addSfxFile, updateSfxFile, deleteSfxFile } from '../../db';
import { csrfProtection } from '../csrf';
import { requireMod } from '../middleware';
import { SFX_FOLDER, SFX_MAX_FILE_MB } from '../../shared/config';
import { safeResolve } from '../../shared/pathUtils';
import { parsePositiveIntId } from './shared';
import { removeSfxFiles } from './sfxMutationsShared';

const log = createLogger('Web');
const router = Router();

const MAX_FILE_BYTES = SFX_MAX_FILE_MB * 1024 * 1024;

/** Multer instance buffering a single uploaded sound in memory, capped at SFX_MAX_FILE_MB. */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('audio/'));
  },
});

/**
 * Detect an audio file's type from its magic bytes, independent of the
 * client-supplied MIME type. Supports the three accepted formats.
 * - WAV: `RIFF` at offset 0 and `WAVE` at offset 8
 * - OGG: `OggS` at offset 0
 * - MP3: `ID3` tag at offset 0, or an MPEG frame-sync (0xFF followed by 0b111xxxxx)
 */
export function detectAudioType(buf: Buffer): 'mp3' | 'ogg' | 'wav' | null {
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).equals(Buffer.from([0x52, 0x49, 0x46, 0x46])) &&
    buf.subarray(8, 12).equals(Buffer.from([0x57, 0x41, 0x56, 0x45]))
  ) {
    return 'wav';
  }
  if (buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x4f, 0x67, 0x67, 0x53]))) {
    return 'ogg';
  }
  if (buf.length >= 3 && buf.subarray(0, 3).equals(Buffer.from([0x49, 0x44, 0x33]))) {
    return 'mp3';
  }
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    return 'mp3';
  }
  return null;
}

/**
 * Build a safe stored filename from the upload's original name, preserving it so
 * the on-disk name keeps its context (e.g. `airhorn.mp3` stays `airhorn.mp3`).
 * Strips any directory, restricts to `[A-Za-z0-9._-]`, and forces the extension
 * to match the magic-byte-detected type. Falls back to `sound.<ext>` if nothing
 * usable remains.
 */
export function buildStoredName(originalName: string, ext: 'mp3' | 'ogg' | 'wav'): string {
  const base = path.basename(originalName);
  let sanitized = base
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '');
  // Drop the original extension; we append the detected one.
  sanitized = sanitized.replace(/\.[^.]*$/, '');
  if (sanitized.length === 0) sanitized = 'sound';
  return `${sanitized}.${ext}`;
}

/**
 * Write `buffer` into SFX_FOLDER under a filename derived from `name`, preserving
 * it so the on-disk name keeps its context. Writes with the exclusive-create flag
 * (`wx`) and, on an `EEXIST` collision, retries with `-1`, `-2`, … suffixes — this
 * closes the check-then-write race so two concurrent uploads of the same name can
 * never overwrite each other. Returns the stored relative filename, or null if the
 * path escapes SFX_FOLDER or no free name is found within the retry budget.
 */
async function writeUniqueSound(name: string, buffer: Buffer): Promise<string | null> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  await fs.promises.mkdir(SFX_FOLDER, { recursive: true });
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? name : `${stem}-${i}${ext}`;
    const fullPath = safeResolve(SFX_FOLDER, candidate);
    if (!fullPath) return null;
    try {
      await fs.promises.writeFile(fullPath, buffer, { flag: 'wx' });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  return null;
}

/** Parse a weight form field into a positive integer, defaulting to 1. */
function parseWeight(value: unknown): number {
  const parsed = typeof value === 'string' ? parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Translate a Multer error into a user-facing redirect, instead of letting it
 * reach the centralised 500 handler. An oversized file (`LIMIT_FILE_SIZE`) gets
 * its own `file_too_large` code; any other error falls back to `upload_failed`.
 * @param err - The error passed by Multer's callback, or null/undefined if none.
 * @param res - Express response used to issue the redirect when an error occurred.
 * @returns true when `err` was an error and a redirect was sent (caller should
 *   stop); false when there was no error (caller should continue).
 */
export function handleUploadError(err: unknown, res: Response): boolean {
  if (!err) return false;
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    res.redirect('/sfx?error=file_too_large');
    return true;
  }
  log.error('SFX upload middleware error:', err);
  res.redirect('/sfx?error=upload_failed');
  return true;
}

/**
 * Express middleware that runs Multer's single-file (`sound`) parser and, on a
 * Multer error (e.g. an oversized file), redirects via `handleUploadError`
 * instead of letting it fall through to the centralised 500 handler.
 * @param req - Express request carrying the multipart upload.
 * @param res - Express response (used for the error redirect).
 * @param next - Called to continue to the route handler when parsing succeeds.
 * @returns {void}
 */
function uploadSound(req: Request, res: Response, next: NextFunction): void {
  upload.single('sound')(req, res, (err: unknown) => {
    if (handleUploadError(err, res)) return;
    next();
  });
}

// csrfProtection runs BEFORE uploadSound so a bad token is rejected before Multer
// buffers the file. The client (sfx.js) sends the token in an X-CSRF-Token header
// — available before body parsing and never placed in the URL.
router.post('/sfx/file/upload', requireMod, csrfProtection, uploadSound, async (req, res) => {
  const triggerId = parsePositiveIntId(req.body.trigger_id);
  if (triggerId === null) return res.redirect('/sfx?error=invalid_id');
  if (!req.file) return res.redirect('/sfx?error=invalid_file');

  const ext = detectAudioType(req.file.buffer);
  if (!ext) return res.redirect('/sfx?error=invalid_file');

  const weight = parseWeight(req.body.weight);
  const hidden = req.body.file_hidden === 'on';

  let storedName: string | null;
  try {
    storedName = await writeUniqueSound(buildStoredName(req.file.originalname, ext), req.file.buffer);
  } catch (err) {
    log.error('Upload SFX file error:', err);
    return res.redirect('/sfx?error=upload_failed');
  }
  if (!storedName) return res.redirect('/sfx?error=invalid_path');

  try {
    await addSfxFile(BigInt(triggerId), storedName, weight, hidden);
  } catch (err) {
    const fullPath = safeResolve(SFX_FOLDER, storedName);
    if (fullPath) await fs.promises.rm(fullPath, { force: true });
    log.error('Upload SFX file error:', err);
    return res.redirect('/sfx?error=upload_failed');
  }

  log.info(`SFX file uploaded for trigger ${triggerId}: ${storedName}`);
  res.redirect('/sfx?success=file_uploaded');
});

router.post('/sfx/file/update', requireMod, csrfProtection, async (req, res) => {
  const fileId = parsePositiveIntId(req.body.file_id);
  if (fileId === null) return res.redirect('/sfx?error=invalid_id');

  const weight = parseWeight(req.body.weight);
  const hidden = req.body.file_hidden === 'on';

  try {
    await updateSfxFile(fileId, weight, hidden);
  } catch (err) {
    log.error('Update SFX file error:', err);
    return res.redirect('/sfx?error=update_failed');
  }

  res.redirect('/sfx?success=file_updated');
});

router.post('/sfx/file/remove', requireMod, csrfProtection, async (req, res) => {
  const fileId = parsePositiveIntId(req.body.file_id);
  if (fileId === null) return res.redirect('/sfx?error=invalid_id');

  try {
    const file = await deleteSfxFile(fileId);
    if (file) await removeSfxFiles([file]);
  } catch (err) {
    log.error('Remove SFX file error:', err);
    return res.redirect('/sfx?error=remove_failed');
  }

  res.redirect('/sfx?success=file_removed');
});

export default router;
