import { createLogger } from '../../shared/logger';
import { Router, type Request, type Response } from 'express';
import path from 'path';
import fs from 'fs';
import { addSfxFile } from '../../db';
import { csrfProtection } from '../csrf';
import { requireMod } from '../middleware';
import { SFX_FOLDER, SFX_MAX_FILE_MB, UPLOAD_INCOMING_FOLDER } from '../../shared/config';
import { ChunkedUploadStore } from '../chunkedUploadStore';
import { mountChunkedUploadRoutes, toMemoryFile } from './chunkedUploadRoutes';
import { safeResolve } from '../../shared/pathUtils';
import { parsePositiveIntId, parsePositiveBigIntId, parseCheckboxField } from './validation';
import { detectAudioType } from './uploadFileTypes';
import type { UploadedFile } from '../uploadedFile';

const log = createLogger('Web');
const router = Router();

const MAX_FILE_BYTES = SFX_MAX_FILE_MB * 1024 * 1024;

/**
 * Build a safe stored filename from the upload's original name, preserving it so
 * the on-disk name keeps its context (e.g. `airhorn.mp3` stays `airhorn.mp3`).
 * Strips any directory, restricts to `[A-Za-z0-9._-]`, and forces the extension
 * to match the magic-byte-detected type. Falls back to `sound.<ext>` if nothing
 * usable remains.
 * @param originalName - The upload's client-supplied filename.
 * @param ext - Extension from magic-byte detection, which replaces the original one.
 * @returns The sanitized filename, e.g. `airhorn.mp3`, or `sound.<ext>` when nothing usable remains.
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
 * @param name - Sanitized filename to store under (see {@link buildStoredName}).
 * @param buffer - The validated audio bytes to write.
 * @returns The stored filename relative to SFX_FOLDER, or null when no safe free name was found.
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
 * @param file The finished upload, read into memory (buffer + originalname).
 * @returns The stored relative filename, or an error code for the caller to redirect with.
 */
async function storeUploadedSound(
  file: UploadedFile,
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
 * Validates and stores an uploaded sound, then inserts its DB row: the handler behind
 * `POST /sfx/file/upload/:uploadId/complete`. Rejects a missing/invalid trigger id, file or
 * weight with the matching error code, and redirects `success=file_uploaded` on success.
 * @param req - Express request; reads `trigger_id`, `weight`, `file_hidden` and `req.file`.
 * @param res - Express response; always issues a redirect.
 * @returns Resolves once the redirect has been sent.
 */
async function handleSoundUpload(req: Request, res: Response): Promise<void> {
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
}

/**
 * Chunked, resumable SFX uploads under `/sfx/file/upload/…` (see `mountChunkedUploadRoutes`).
 * No MIME-based filter: browsers send `application/octet-stream` for some audio files, and
 * storeUploadedSound() validates the actual bytes via detectAudioType. The client (sfx.js via
 * chunkedUpload.js) sends the CSRF token in an X-CSRF-Token header.
 */
mountChunkedUploadRoutes(router, {
  path: '/sfx/file/upload',
  store: new ChunkedUploadStore({ dir: path.join(UPLOAD_INCOMING_FOLDER, 'sfx'), maxBytes: MAX_FILE_BYTES }),
  guards: [requireMod, csrfProtection],
  field: 'sound',
  toFile: toMemoryFile,
  complete: [handleSoundUpload],
  basePath: '/sfx',
  log,
});

export default router;
