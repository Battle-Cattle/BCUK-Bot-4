import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { addSfxFile } from '../../db';
import { csrfProtection } from '../csrf';
import { requireMod } from '../middleware';
import { SFX_FOLDER, SFX_MAX_FILE_MB } from '../../shared/config';
import { safeResolve } from '../../shared/pathUtils';
import { parsePositiveIntId, parsePositiveBigIntId, parseCheckboxField } from './validation';
import { createMulterErrorRedirectHandler, makeUploadMiddleware } from './uploadMiddleware';

const log = createLogger('Web');
const router = Router();

const MAX_FILE_BYTES = SFX_MAX_FILE_MB * 1024 * 1024;

// No MIME-based fileFilter: the client-supplied Content-Type is unreliable
// (browsers send `application/octet-stream` for some audio files), and
// storeUploadedSound() validates the actual bytes via detectAudioType. Filtering
// on mimetype here would reject valid audio with a generic/incorrect header.
/** Multer instance buffering a single uploaded sound in memory, capped at SFX_MAX_FILE_MB. */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

/**
 * True if `buf` starts with a complete, well-formed 10-byte ID3v2 header:
 * the "ID3" tag, a version byte that isn't the reserved 0xFF, and a syncsafe
 * size (each of the 4 size bytes has its top bit clear). Checking the full
 * header — not just the 3-byte tag — avoids misidentifying truncated/junk
 * payloads as MP3.
 */
function isValidId3Header(buf: Buffer): boolean {
  if (buf.length < 10) return false;
  if (!buf.subarray(0, 3).equals(Buffer.from([0x49, 0x44, 0x33]))) return false;
  if (buf[3] === 0xff || buf[4] === 0xff) return false;
  return (buf[6] & 0x80) === 0 && (buf[7] & 0x80) === 0 && (buf[8] & 0x80) === 0 && (buf[9] & 0x80) === 0;
}

/**
 * Detect an audio file's type from its magic bytes, independent of the
 * client-supplied MIME type. Supports the three accepted formats.
 * - WAV: `RIFF` at offset 0 and `WAVE` at offset 8
 * - OGG: `OggS` at offset 0
 * - MP3: a complete 10-byte ID3v2 header at offset 0, or a valid MPEG audio
 *   frame header (see below)
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
  if (isValidId3Header(buf)) {
    return 'mp3';
  }
  // MPEG audio frame: 11-bit sync (0xFF then top 3 bits of byte 1) followed by a
  // valid version/layer/bitrate/sample-rate. Validate the full 4-byte header and
  // reject the reserved bit combinations so junk like `FF E0 00 00` — which only
  // matches the sync — isn't mistaken for MP3.
  if (buf.length >= 4 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    const versionBits = (buf[1] >> 3) & 0x03; // 0x01 = reserved MPEG version
    const layerBits = (buf[1] >> 1) & 0x03; // 0x00 = reserved layer
    const bitrateBits = (buf[2] >> 4) & 0x0f; // 0x0f = bad/invalid bitrate
    const sampleRateBits = (buf[2] >> 2) & 0x03; // 0x03 = reserved sample rate
    if (
      versionBits !== 0x01 &&
      layerBits !== 0x00 &&
      bitrateBits !== 0x0f &&
      sampleRateBits !== 0x03
    ) {
      return 'mp3';
    }
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

/**
 * Validate an uploaded buffer's audio type and write it to disk under a unique,
 * sanitized name. Isolates the upload route's file-storage branch so the route
 * handler itself only deals with the trigger/weight validation and persistence.
 * @param file Multer's in-memory file (buffer + originalname).
 * @returns The stored relative filename, or an error code for the caller to redirect with.
 */
async function storeUploadedSound(
  file: Express.Multer.File,
): Promise<{ storedName: string } | { errorCode: 'invalid_file' | 'invalid_path' | 'upload_failed' }> {
  const ext = detectAudioType(file.buffer);
  if (!ext) return { errorCode: 'invalid_file' };

  let storedName: string | null;
  try {
    storedName = await writeUniqueSound(buildStoredName(file.originalname, ext), file.buffer);
  } catch (err) {
    log.error('Upload SFX file error:', err);
    return { errorCode: 'upload_failed' };
  }
  if (!storedName) return { errorCode: 'invalid_path' };
  return { storedName };
}

/**
 * Persist an already-stored sound file's DB row. On failure, rolls back the
 * on-disk file (guarding the cleanup itself so a failed `rm()` can't escape
 * this function and turn the caller's intended redirect into a 500).
 * @param triggerId Owning trigger id (bigint — `sfxtrigger.id` is a BIGINT column).
 * @param storedName Relative filename already written under SFX_FOLDER.
 * @param weight Weighted-random selection weight.
 * @param hidden Whether the file is hidden from the public listing.
 * @returns true on success, false if the DB insert failed (and was rolled back).
 */
async function persistUploadedSound(
  triggerId: bigint,
  storedName: string,
  weight: number,
  hidden: boolean,
): Promise<boolean> {
  try {
    await addSfxFile(triggerId, storedName, weight, hidden);
    return true;
  } catch (err) {
    const fullPath = safeResolve(SFX_FOLDER, storedName);
    if (fullPath) {
      try {
        await fs.promises.rm(fullPath, { force: true });
      } catch (cleanupErr) {
        log.error(`Failed to roll back uploaded SFX file ${storedName}:`, cleanupErr);
      }
    }
    log.error('Upload SFX file error:', err);
    return false;
  }
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
export const handleUploadError = createMulterErrorRedirectHandler('/sfx', log, 'SFX upload middleware error:');

/** Express middleware running Multer's single-file (`sound`) parser, redirecting on error. */
const uploadSound = makeUploadMiddleware(upload, 'sound', handleUploadError);

// csrfProtection runs BEFORE uploadSound so a bad token is rejected before Multer
// buffers the file. The client (sfx.js) sends the token in an X-CSRF-Token header
// — available before body parsing and never placed in the URL.
/**
 * POST /sfx/file/upload — validate and store an uploaded sound, then insert its
 * DB row. Rejects a missing/invalid trigger id, file, or weight with the matching
 * error code, stores the buffer via `storeUploadedSound`, persists the row via
 * `persistUploadedSound`, and redirects `success=file_uploaded` on success.
 * @param req Express request; reads `trigger_id`, `weight`, `file_hidden` and `req.file`.
 * @param res Express response; always issues a redirect.
 */
router.post('/sfx/file/upload', requireMod, csrfProtection, uploadSound, async (req, res) => {
  const triggerId = parsePositiveBigIntId(req.body.trigger_id);
  if (triggerId === null) return res.redirect('/sfx?error=invalid_id');
  if (!req.file) return res.redirect('/sfx?error=invalid_file');

  const weight = parsePositiveIntId(req.body.weight);
  if (weight === null) return res.redirect('/sfx?error=invalid_weight');
  const hidden = parseCheckboxField(req.body.file_hidden);

  const stored = await storeUploadedSound(req.file);
  if ('errorCode' in stored) return res.redirect(`/sfx?error=${stored.errorCode}`);

  const persisted = await persistUploadedSound(triggerId, stored.storedName, weight, hidden);
  if (!persisted) return res.redirect('/sfx?error=upload_failed');

  log.info(`SFX file uploaded for trigger ${triggerId}: ${stored.storedName}`);
  res.redirect('/sfx?success=file_uploaded');
});

export default router;
