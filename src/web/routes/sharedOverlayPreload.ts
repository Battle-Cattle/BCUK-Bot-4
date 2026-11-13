import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream';
import type { Request, Response } from 'express';
import { OVERLAY_FOLDER, SHARED_OVERLAY_PRELOAD_KB_PER_SECOND } from '../../shared/config';
import { createLogger } from '../../shared/logger';
import { resolveSharedFile } from './streamerFileServing';
import { createByteBudget, createThrottle } from './sharedOverlayPreloadThrottle';
import { SHARED_FOLDER } from './sharedOverlayVideoFiles';

// The speed-limited variant of the shared video route, `?preload=1` (#917): same files and Range
// support, but every response shares one byte budget. Trigger fallbacks and Manager pushes use the
// normal route at full speed.

const log = createLogger('SharedOverlayPreload');

/** The one budget all preload responses draw from. */
export const preloadBudget = createByteBudget(SHARED_OVERLAY_PRELOAD_KB_PER_SECOND * 1024);

/**
 * Reads a single `bytes=` range of a file.
 * @param header - The `Range` request header, if any.
 * @param size - File size in bytes.
 * @returns The inclusive byte range to send; `null` for no range header (send it all); `'invalid'`
 *   for a malformed or unsatisfiable range, or one with several parts.
 */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (match[1] === '') { // a suffix range: the last N bytes
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start > end || start >= size ? 'invalid' : { start, end };
}

/**
 * Serves a shared video through the preload budget, honouring a single `Range`. A client that
 * disconnects stops the file read and gives up its wait for tokens.
 * @param req - Express request; reads the `filename` route param and the `Range` header.
 * @param res - Express response; sends 200 or 206 with the (throttled) bytes, 416 for a bad range,
 *   or the 400/404 `resolveSharedFile` sends for a bad or missing file.
 * @returns Resolves once the response has been started (or refused).
 */
export async function servePreloadVideo(req: Request, res: Response): Promise<void> {
  // POSIX join, like safeResolve (which resolveSharedFile uses on it) and the bot's Linux target.
  const folder = path.posix.join(OVERLAY_FOLDER, SHARED_FOLDER);
  const file = await resolveSharedFile(res, folder, String(req.params.filename), /^[\w-]+\.(webm)$/i);
  if (!file) return;
  let size: number;
  try {
    size = (await fs.promises.stat(file.realPath)).size;
  } catch {
    res.status(404).end();
    return;
  }
  const range = parseByteRange(req.headers.range, size);
  if (range === 'invalid') {
    res.status(416).set('Content-Range', `bytes */${size}`).end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  res.status(range ? 206 : 200);
  res.set({ 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) });
  if (range) res.set('Content-Range', `bytes ${start}-${end}/${size}`);
  if (size === 0) { res.end(); return; }
  pipeline(fs.createReadStream(file.realPath, { start, end }), createThrottle(preloadBudget), res, (err) => {
    // A client going away mid-response is normal (OBS closing); anything else is worth a line.
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') log.warn('Preload response failed:', err);
  });
}
