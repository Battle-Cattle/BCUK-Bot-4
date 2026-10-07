import multer from 'multer';
import fs from 'fs';
import type { Request, Response, NextFunction } from 'express';
import type { Logger } from 'winston';
import { requireStreamer } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';

/**
 * Builds a Multer error-handling callback that translates an oversized-file error
 * (`LIMIT_FILE_SIZE`) into a `file_too_large` redirect, and any other Multer/middleware
 * error into a logged `upload_failed` redirect — instead of letting either reach the
 * centralised 500 handler. Shared by every file-upload route (SFX sounds, overlay videos).
 * @param basePath - Path to redirect to, without query string (e.g. `/sfx`).
 * @param log - Logger to record non-size-limit errors on.
 * @param logLabel - Message prefix passed to `log.error`.
 * @returns A handler: true when `err` was an error and a redirect was sent (caller should
 *   stop); false when there was no error (caller should continue).
 */
export function createMulterErrorRedirectHandler(
  basePath: string,
  log: Logger,
  logLabel: string,
): (err: unknown, res: Response) => boolean {
  return (err: unknown, res: Response): boolean => {
    if (!err) return false;
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.redirect(`${basePath}?error=file_too_large`);
      return true;
    }
    log.error(logLabel, err);
    res.redirect(`${basePath}?error=upload_failed`);
    return true;
  };
}

/**
 * Builds Express middleware that runs Multer's single-file parser for `field` and, on a Multer
 * error (e.g. an oversized file), redirects via `handleUploadError` instead of letting it fall
 * through to the centralised 500 handler. Shared by every file-upload route (SFX sounds, overlay
 * videos, alert images/sounds) — they previously each defined their own copy of this wrapper,
 * differing only in the Multer instance and field name.
 * @param upload - Multer instance configured for this upload (storage + size limit).
 * @param field - Form field name Multer should parse as the single uploaded file.
 * @param handleUploadError - Error handler from `createMulterErrorRedirectHandler`, run on a Multer error.
 * @returns Express middleware: parses `field` via Multer, then calls `next()` on success.
 */
export function makeUploadMiddleware(
  upload: multer.Multer,
  field: string,
  handleUploadError: (err: unknown, res: Response) => boolean,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    upload.single(field)(req, res, (err: unknown) => {
      if (handleUploadError(err, res)) return;
      next();
    });
  };
}

/**
 * Writes `buffer` to `fullPath`; if the write fails partway (e.g. `ENOSPC`), best-effort removes
 * the partial file — logging, not throwing, if that removal also fails — and rethrows the
 * original write error so the caller's `upload_failed` handling still applies. Shared by the
 * overlay-video and alert-asset upload routes.
 * @param fullPath - Absolute destination path (already safe-resolved).
 * @param buffer - File contents to write.
 * @param log - Logger to record a failed cleanup on.
 * @returns Resolves once the file is fully written.
 * @throws The original write error, after attempting cleanup.
 */
export async function writeFileOrCleanup(fullPath: string, buffer: Buffer, log: Logger): Promise<void> {
  try {
    await fs.promises.writeFile(fullPath, buffer);
  } catch (err) {
    try {
      await fs.promises.rm(fullPath, { force: true });
    } catch (rmErr) {
      log.error(`Failed to remove partially written file ${fullPath}:`, rmErr);
    }
    throw err;
  }
}

/** Options for {@link makeRequireStreamerBeforeUpload}. */
export interface RequireStreamerBeforeUploadOptions {
  /** Redirect target for a requester who isn't a streamer (e.g. `/overlay/settings?error=not_a_streamer`). */
  notAStreamerRedirect: string;
  /** Path to redirect to with `?error=upload_failed` if the streamer lookup fails. */
  basePath: string;
  /** Logger to record a failed lookup on. */
  log: Logger;
  /** Message prefix for that log entry. */
  logLabel: string;
}

/**
 * Builds Express middleware that redirects non-streamers *before* Multer buffers an upload into
 * memory, so an authenticated non-streamer can't force a full-size in-memory upload only to be
 * rejected afterwards. Mount it between `csrfProtection` and the Multer middleware; the route
 * handler still re-checks via `requireStreamer`. Shared by the overlay-video and alert-asset
 * upload routes.
 * @param options - See {@link RequireStreamerBeforeUploadOptions}.
 * @returns Express middleware: calls `next()` for a streamer, otherwise redirects.
 */
export function makeRequireStreamerBeforeUpload(
  options: RequireStreamerBeforeUploadOptions,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const { notAStreamerRedirect, basePath, log, logLabel } = options;
  return async (req, res, next) => {
    try {
      if (await requireStreamer(req, res, notAStreamerRedirect)) next();
    } catch (err) {
      logAndRedirectError({ res, log, logLabel, err, basePath, errorCode: 'upload_failed' });
    }
  };
}
