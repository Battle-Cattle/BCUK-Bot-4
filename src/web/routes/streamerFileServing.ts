// Serves a file a streamer uploaded (overlay videos, alert assets) from `<folder>/<streamerId>/<filename>`,
// with the path checks both unauthenticated file routes share. Used by overlaySource.ts and
// alertsOverlaySource.ts.
import type { Response } from 'express';
import { safeResolve, realPathWithin } from '../../shared/pathUtils';

/** A validated, symlink-resolved file ready for {@link sendStreamerFile}. */
export interface ResolvedStreamerFile {
  /** Real path of the file, inside the folder. */
  realPath: string;
  /** The filename's match against the route's filename pattern (for its captured extension). */
  match: RegExpExecArray;
}

/** The `:streamerId`/`:filename` route params of a streamer file route. */
export interface StreamerFileParams {
  /** The streamer's DB id, as the raw route param. */
  streamerId: string;
  /** The requested file's name, as the raw route param. */
  filename: string;
}

/**
 * Validates a streamer file request and resolves it to a real path inside `folder`, replying
 * itself when it can't: 400 for a non-numeric `streamerId`, a filename not matching
 * `filenamePattern` or a lexically unsafe path; 404 when the file doesn't exist or its real path
 * (following symlinks) is outside `folder`.
 * @param res - Express response; only used to reply 400/404.
 * @param folder - Base folder holding one subfolder per streamer id.
 * @param params - The raw `streamerId` and `filename` route params.
 * @param filenamePattern - Allowed filenames; its first capture group should be the extension.
 * @returns The resolved file, or null once a 400/404 has been sent.
 */
export async function resolveStreamerFile(
  res: Response,
  folder: string,
  params: StreamerFileParams,
  filenamePattern: RegExp,
): Promise<ResolvedStreamerFile | null> {
  const { streamerId, filename } = params;
  const match = /^\d+$/.test(streamerId) ? filenamePattern.exec(filename) : null;
  const resolved = match ? safeResolve(folder, streamerId, filename) : null;
  if (!match || !resolved) {
    res.status(400).end();
    return null;
  }

  // safeResolve is purely lexical; also follow symlinks and re-check containment, since
  // sendFile would follow a link under the folder that points outside it. Not atomic with the
  // open inside sendFile: a path component swapped for a link in between would still be
  // followed. Closing that needs fd-based serving (losing sendFile's Range/ETag handling, which
  // videos rely on), and exploiting it needs write access to the folder — which already allows
  // replacing the served files. Keeping the folder writable only by the bot's user (README,
  // "Deployment") is what actually closes it.
  const realPath = await realPathWithin(folder, resolved).catch(() => null);
  if (!realPath) {
    res.status(404).end();
    return null;
  }
  return { realPath, match };
}

/**
 * Sends a file resolved by {@link resolveStreamerFile}. A TOCTOU race is possible: the file can be
 * removed (e.g. by a concurrent delete) between the realpath check and sendFile() reading it.
 * Passing a callback stops Express from falling through to the default error handler (a 500)
 * for that race — this replies 404 instead, as long as headers haven't already gone out.
 * @param res - Express response to send the file on.
 * @param realPath - The file's real path, from {@link resolveStreamerFile}.
 */
export function sendStreamerFile(res: Response, realPath: string): void {
  res.sendFile(realPath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).end();
    }
  });
}
