import fs from 'fs';
import type { Request, NextFunction, Response } from 'express';
import type { Logger } from 'winston';
import { requireStreamer } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';

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
 * Builds Express middleware that redirects non-streamers before any chunked-upload route runs,
 * so an authenticated non-streamer can't start an upload (or send pieces) only to be rejected
 * at the end. Mount it after `csrfProtection` in each area's chunked-upload guards; the route
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
