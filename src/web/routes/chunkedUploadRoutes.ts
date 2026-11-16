import fs from 'fs';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import type { Logger } from 'winston';
import {
  CHUNK_MAX_BYTES,
  type ChunkedUploadError,
  type ChunkedUploadStore,
  type FinishedChunkedUpload,
} from '../chunkedUploadStore';
import { parseDeclaration, type ChunkedUploadDeclaration } from '../chunkedUploadDeclaration';
import type { UploadedFile } from '../uploadedFile';

// The routes of a chunked, resumable upload (issue #912), mounted once per upload area under
// that area's upload path. The page starts an upload, sends it in pieces of at most
// CHUNK_MAX_BYTES (each its own short request, re-sent at the same offset if it fails), and then
// completes it with the form's other fields. Completing turns the assembled file into the
// `req.file` the area's existing upload handler expects, so each area keeps its own type checks,
// storage and redirects.

/**
 * Error codes a chunked upload can send a page back with, on top of each area's own: another
 * upload by the same user still running, an upload completed before every piece arrived, one
 * that expired (or was never this user's), and a malformed start. Each upload page lists them
 * among its known errors.
 */
export const CHUNKED_UPLOAD_ERROR_CODES = ['upload_busy', 'upload_incomplete', 'upload_expired', 'invalid_upload'] as const;

/** HTTP status for each refusal, answered as JSON to the page's uploader. */
const ERROR_STATUS: Record<ChunkedUploadError, number> = {
  invalid_upload: 400,
  not_found: 404,
  bad_offset: 409,
  upload_busy: 409,
  incomplete: 409,
  file_too_large: 413,
};

/** Options for {@link mountChunkedUploadRoutes}. */
export interface ChunkedUploadRouteOptions {
  /** The area's upload path on its router, e.g. `/settings/videos/upload`. */
  path: string;
  /** The area's session store. */
  store: ChunkedUploadStore;
  /** Run before every chunk route: auth, CSRF and the area's per-page checks. */
  guards: RequestHandler[];
  /** Name of the form's file field, given to `req.file.fieldname`. */
  field: string;
  /**
   * Optional per-area check at start, given the declaration and the request (for the requester);
   * returns an error code (answered with 409) or null, directly or as a promise.
   */
  checkStart?: (declared: ChunkedUploadDeclaration, req: Request) => string | null | Promise<string | null>;
  /** Turns a finished upload into the `req.file` the area's handler expects. */
  toFile: (finished: FinishedChunkedUpload, field: string) => Promise<UploadedFile>;
  /** The area's existing handlers, run once `req.file` is set; they redirect as they do today. */
  complete: RequestHandler[];
  /** Page to redirect to with `?error=<code>` when the upload can't be completed. */
  basePath: string;
  /** Logger for failures. */
  log: Logger;
  /** Extra cleanup run with each periodic sweep (e.g. the overlay incoming folder); must not reject. */
  onSweep?: () => Promise<void>;
}

/**
 * How often each area's abandoned sessions are swept, besides the sweep every start runs, so
 * they're removed even when no further upload starts.
 */
export const CHUNKED_UPLOAD_SWEEP_INTERVAL_MS = 15 * 60_000;

/**
 * The Discord ID of the logged-in user, who owns the uploads they start.
 * @param req - Express request (behind `requireAuth`).
 * @returns The user's Discord ID, or null with no user in the session.
 */
function ownerOf(req: Request): string | null {
  return req.session.user?.discordId ?? null;
}

/**
 * Answers a refusal as JSON with its status code.
 * @param res - Express response.
 * @param failure - The refusal: its error code plus any `received`/`activeId`.
 * @param failure.error - Why the request was refused.
 * @returns Nothing; the response has been sent.
 */
function sendFailure(res: Response, failure: { error: ChunkedUploadError; received?: number; activeId?: string }): void {
  const { error, received, activeId } = failure;
  res.status(ERROR_STATUS[error]).json({ error, received, activeId });
}

/**
 * Wraps an async JSON handler so a thrown error is logged and answered as a 500.
 * @param log - Logger for the error.
 * @param label - Message prefix for the log entry.
 * @param handler - The handler to run with the requester's Discord ID.
 * @returns Express middleware.
 */
function jsonRoute(log: Logger, label: string, handler: JsonHandler): RequestHandler {
  return async (req, res) => {
    const owner = ownerOf(req);
    if (!owner) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    try {
      await handler(req, res, owner);
    } catch (err) {
      log.error(label, err);
      if (!res.headersSent) res.status(500).json({ error: 'upload_failed' });
    }
  };
}

/**
 * Parses a piece's `offset` query value.
 * @param raw - The query value (untrusted).
 * @returns The offset as a whole, non-negative number, or null when malformed.
 */
export function parseOffset(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * Turns a finished upload into an in-memory `req.file` (for the areas whose files are small
 * enough to check from a buffer: SFX and alert assets), removing the assembled file.
 * @param finished - The finished upload from the store.
 * @param field - Name of the form's file field.
 * @returns The file record, with `buffer` set.
 */
export async function toMemoryFile(finished: FinishedChunkedUpload, field: string): Promise<UploadedFile> {
  try {
    const buffer = await fs.promises.readFile(finished.path);
    return {
      fieldname: field,
      originalname: finished.name,
      mimetype: finished.type,
      size: buffer.length,
      buffer,
      filename: '',
      path: '',
    };
  } finally {
    await fs.promises.rm(finished.path, { force: true });
  }
}

/**
 * Builds the complete route's first step: finishes the upload and sets `req.file`, or
 * redirects with an error so the area's handlers never run.
 * @param options - The area's route options.
 * @returns Express middleware.
 */
function finishUpload(options: ChunkedUploadRouteOptions): RequestHandler {
  const { store, field, toFile, basePath, log } = options;
  return async (req: Request, res: Response, next: NextFunction) => {
    const owner = ownerOf(req);
    const id = String(req.params.uploadId);
    try {
      const finished = owner ? await store.finish(owner, id) : null;
      if (!finished?.ok) {
        res.redirect(`${basePath}?error=${finished?.error === 'incomplete' ? 'upload_incomplete' : 'upload_expired'}`);
        return;
      }
      req.file = await toFile(finished, field);
      next();
    } catch (err) {
      log.error('Chunked upload completion error:', err);
      res.redirect(`${basePath}?error=upload_failed`);
    }
  };
}

/**
 * Mounts one upload area's chunked-upload routes on `router`:
 * - `POST <path>/start` (JSON `{name, size, type}`) → `{id, chunkSize}`, or 409 `upload_busy`
 *   with the user's running upload as `activeId`, or 413 `file_too_large`;
 * - `GET <path>/:uploadId` → `{received, size}`, so the page can resume;
 * - `PUT <path>/:uploadId/chunk?offset=N` (raw bytes) → `{received}`, or 409 `bad_offset` with the
 *   confirmed `received` offset to resume from;
 * - `DELETE <path>/:uploadId` → 204, abandoning the upload (500 `upload_failed` if its files
 *   couldn't all be removed);
 * - `POST <path>/:uploadId/complete` (the form's other fields) → the area's handlers, which redirect.
 *
 * Another user's upload ID, or an expired one, answers 404.
 * @param router - The area's Express router.
 * @param options - See {@link ChunkedUploadRouteOptions}.
 * @returns Nothing; the routes are mounted.
 */
export function mountChunkedUploadRoutes(router: Router, options: ChunkedUploadRouteOptions): void {
  const { path, guards, log } = options;
  const rawBody = express.raw({ type: () => true, limit: CHUNK_MAX_BYTES });
  router.post(`${path}/start`, ...guards, jsonRoute(log, 'Chunked upload start error:', startHandler(options)));
  router.get(`${path}/:uploadId`, ...guards, jsonRoute(log, 'Chunked upload status error:', statusHandler(options.store)));
  router.put(`${path}/:uploadId/chunk`, ...guards, rawBody, jsonRoute(log, 'Chunked upload piece error:', pieceHandler(options.store)));
  router.delete(`${path}/:uploadId`, ...guards, jsonRoute(log, 'Chunked upload cancel error:', cancelHandler(options.store)));
  router.post(`${path}/:uploadId/complete`, ...guards, finishUpload(options), ...options.complete);
  // unref()ed: a pending sweep never keeps the process alive on shutdown.
  setInterval(() => void sweepArea(options), CHUNKED_UPLOAD_SWEEP_INTERVAL_MS).unref();
}

/**
 * Sweeps one area's abandoned sessions, then runs its extra cleanup.
 * @param options - The area's route options.
 * @returns Resolves once both have run; never rejects.
 */
async function sweepArea(options: ChunkedUploadRouteOptions): Promise<void> {
  await options.store.sweep();
  await options.onSweep?.();
}

/** A JSON route body run by {@link jsonRoute} with the requester's Discord ID. */
type JsonHandler = (req: Request, res: Response, owner: string) => Promise<void>;

/**
 * Builds the start route: checks the declaration and the area's own rule, then starts a session.
 * @param options - The area's route options.
 * @returns The route body.
 */
function startHandler(options: ChunkedUploadRouteOptions): JsonHandler {
  const { store, checkStart } = options;
  return async (req, res, owner) => {
    // Each start also clears abandoned sessions, so they never outlive the next upload by long.
    void store.sweep();
    const declared = parseDeclaration(req.body);
    const refused = declared ? await checkStart?.(declared, req) : null;
    if (!declared || refused) {
      res.status(declared ? 409 : 400).json({ error: refused ?? 'invalid_upload' });
      return;
    }
    const started = await store.start(owner, declared);
    if (started.ok) res.json({ id: started.id, chunkSize: CHUNK_MAX_BYTES });
    else sendFailure(res, started);
  };
}

/**
 * Builds the status route, reporting the confirmed offset so the page can resume.
 * @param store - The area's session store.
 * @returns The route body.
 */
function statusHandler(store: ChunkedUploadStore): JsonHandler {
  return async (req, res, owner) => {
    const status = await store.status(owner, String(req.params.uploadId));
    if (status.ok) res.json({ received: status.received, size: status.size });
    else sendFailure(res, status);
  };
}

/**
 * Builds the piece route, appending the raw body at the `offset` query value.
 * @param store - The area's session store.
 * @returns The route body.
 */
function pieceHandler(store: ChunkedUploadStore): JsonHandler {
  return async (req, res, owner) => {
    const offset = parseOffset(req.query.offset);
    const chunk: unknown = req.body;
    const appended = offset !== null && Buffer.isBuffer(chunk)
      ? await store.append(owner, String(req.params.uploadId), offset, chunk)
      : { ok: false as const, error: 'bad_offset' as const };
    if (appended.ok) res.json({ received: appended.received });
    else sendFailure(res, appended);
  };
}

/**
 * Builds the cancel route, abandoning the requester's upload.
 * @param store - The area's session store.
 * @returns The route body.
 */
function cancelHandler(store: ChunkedUploadStore): JsonHandler {
  return async (req, res, owner) => {
    const result = await store.cancel(owner, String(req.params.uploadId));
    if (result === 'cancelled') res.status(204).end();
    else if (result === 'not_found') sendFailure(res, { error: 'not_found' });
    else res.status(500).json({ error: 'upload_failed' });
  };
}
