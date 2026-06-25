import { createLogger } from '../../shared/logger';
import { Router } from 'express';
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
 * Resolve a collision-free absolute path within SFX_FOLDER for `name`. If the
 * file already exists, appends `-1`, `-2`, … before the extension so an upload
 * never silently overwrites an existing sound. Returns the resolved absolute
 * path and the final relative filename, or null if the path escapes SFX_FOLDER.
 */
function resolveUniquePath(name: string): { fullPath: string; storedName: string } | null {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? name : `${stem}-${i}${ext}`;
    const fullPath = safeResolve(SFX_FOLDER, candidate);
    if (!fullPath) return null;
    if (!fs.existsSync(fullPath)) return { fullPath, storedName: candidate };
  }
  return null;
}

/** Parse a weight form field into a positive integer, defaulting to 1. */
function parseWeight(value: unknown): number {
  const parsed = typeof value === 'string' ? parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

// csrfProtection runs BEFORE upload.single so a bad token is rejected before Multer
// buffers the file. The CSRF token is passed in the URL query string (?_csrf=…) so
// it is available before body parsing.
router.post('/sfx/file/upload', requireMod, csrfProtection, upload.single('sound'), async (req, res) => {
  const triggerId = parsePositiveIntId(req.body.trigger_id);
  if (triggerId === null) return res.redirect('/sfx?error=invalid_id');
  if (!req.file) return res.redirect('/sfx?error=invalid_file');

  const ext = detectAudioType(req.file.buffer);
  if (!ext) return res.redirect('/sfx?error=invalid_file');

  const weight = parseWeight(req.body.weight);
  const hidden = req.body.file_hidden === 'on';

  const resolved = resolveUniquePath(buildStoredName(req.file.originalname, ext));
  if (!resolved) return res.redirect('/sfx?error=invalid_path');

  try {
    await fs.promises.mkdir(SFX_FOLDER, { recursive: true });
    await fs.promises.writeFile(resolved.fullPath, req.file.buffer);
    try {
      await addSfxFile(BigInt(triggerId), resolved.storedName, weight, hidden);
    } catch (dbErr) {
      await fs.promises.rm(resolved.fullPath, { force: true });
      throw dbErr;
    }
  } catch (err) {
    log.error('Upload SFX file error:', err);
    return res.redirect('/sfx?error=upload_failed');
  }

  log.info(`SFX file uploaded for trigger ${triggerId}: ${resolved.storedName}`);
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
