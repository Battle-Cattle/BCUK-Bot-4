import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import type { Logger } from 'winston';

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
