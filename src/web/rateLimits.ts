import { createHash } from 'crypto';
import rateLimit, { ipKeyGenerator, type AugmentedRequest, type Options, type RateLimitExceededEventHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { createLogger } from '../shared/logger';

const log = createLogger('RateLimit');

/**
 * When each limiter/key pair may next be logged (ms since the epoch): a blocked client keeps
 * hitting the limit until its window resets, and one error line per window is enough to see it.
 */
const loggedUntil = new Map<string, number>();

/**
 * Logs, as an error, that a client hit a limiter: at most once per limiter and key until that
 * key's window resets, so a flood doesn't flood the error log too.
 * @param name - Which limiter it was, as it appears in the log line.
 * @param req - The blocked request; express-rate-limit has set `req.rateLimit` on it.
 * @param windowMs - The limiter's window, used when the store doesn't report a reset time.
 */
function logLimitReached(name: string, req: Request, windowMs: number): void {
  const info = (req as AugmentedRequest).rateLimit;
  const key = info?.key ?? 'unknown';
  const now = Date.now();
  const entry = `${name}\0${key}`;
  if ((loggedUntil.get(entry) ?? 0) > now) return;
  for (const [stale, until] of loggedUntil) if (until <= now) loggedUntil.delete(stale);
  loggedUntil.set(entry, info?.resetTime?.getTime() ?? now + windowMs);
  const count = info ? `${info.used}/${info.limit}` : 'over the limit';
  log.error(`${name} rate limit reached for ${key} (${count} requests in the window), last ${req.method} ${req.path}`);
}

/**
 * Sends the limiter's usual "too many requests" response, as express-rate-limit's default handler does.
 * @param req - The blocked request.
 * @param res - Its response.
 * @param options - The limiter's options (status code and message).
 * @returns Resolves once the response is sent.
 */
async function sendLimitResponse(req: Request, res: Response, options: Options): Promise<void> {
  const message: unknown = typeof options.message === 'function' ? await options.message(req, res) : options.message;
  if (!res.writableEnded) res.status(options.statusCode).send(message);
}

/**
 * Builds the handler every limiter uses when a client goes over its limit: logs it as an error
 * (see {@link logLimitReached}), then answers with the limiter's usual 429.
 * @param name - The limiter's name for the log line, e.g. "pre-session".
 * @returns An express-rate-limit `handler`.
 */
export function limitReachedHandler(name: string): RateLimitExceededEventHandler {
  return (req, res, _next, options) => {
    logLimitReached(name, req, options.windowMs);
    sendLimitResponse(req, res, options).catch((err: unknown) => {
      log.error(`Failed to send the ${name} rate-limit response`, err);
    });
  };
}

/**
 * Returns `req.session`, typed as possibly absent: express-session continues without attaching a
 * session when it can't reach its store, and these limiters run on every request regardless.
 * @param req - Express request object
 * @returns The request's session, or undefined if none was attached
 */
function maybeSession(req: Request): Request['session'] | undefined {
  return req.session;
}

/**
 * Tighter limit for auth endpoints to protect against OAuth quota exhaustion.
 * Shared between `/auth/*` (mounted as a path-scoped middleware in server.ts) and
 * the companion app's OAuth routes (applied per-route in companionAuth.ts, since
 * that router is mounted at '/' and a blanket `.use()` there would rate-limit
 * every request on the site, not just companion-auth ones).
 */
export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: 'Too many requests, please try again shortly.',
  handler: limitReachedHandler('auth'),
});

/**
 * Derives a rate-limit key from the request's IP address.
 * Falls back to socket.remoteAddress, then "unknown" if neither is available.
 * @param req - Express request object
 * @returns IP-based rate-limit key
 */
export function ipKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown');
}

/**
 * Determines whether to skip the general IP-based rate limiter.
 * Skips for authenticated session users (covered by sessionLimiter) and
 * for the Streamdeck API (its own token-keyed limiter).
 * @param req - Express request object
 * @returns true if the general limiter should be skipped
 */
export function generalLimiterSkip(req: Request): boolean {
  return req.path.startsWith('/api/streamdeck') || !!maybeSession(req)?.user;
}

/**
 * Tells whether a request carries an express-session cookie (`connect.sid`), i.e. whether the
 * session middleware will look it up in the store.
 * @param req - Express request object
 * @returns true if the Cookie header names `connect.sid` (spaces around the name are allowed, as
 *   the cookie parser express-session uses trims them)
 */
function hasSessionCookie(req: Request): boolean {
  return /(?:^|;)\s*connect\.sid\s*=/.test(req.headers.cookie ?? '');
}

/**
 * Determines whether to skip the coarse IP-keyed limiter that runs ahead of the session middleware.
 * Only Streamdeck API calls without a session cookie are skipped: those never touch the session
 * store and have their own limiters. One that carries a cookie still costs a store lookup (the
 * session middleware runs on every path), so it is counted like any other request.
 * @param req - Express request object
 * @returns true if the pre-session limiter should be skipped
 */
export function preSessionLimiterSkip(req: Request): boolean {
  return req.path.startsWith('/api/streamdeck') && !hasSessionCookie(req);
}

/** Marks an error as coming from the session store, so the error handler can tell it apart. */
const SESSION_STORE_ERROR = Symbol('sessionStoreError');

/**
 * Marks an error the session middleware passed on as a session-store failure. Only errors marked
 * this way can become the 503 below; the bot's own pool raises the same mysql2 message when its
 * queue is full, and that must stay a 500.
 * @param err - The error express-session handed to `next()`.
 * @returns The same error, marked when it is an object.
 */
export function markSessionStoreError(err: unknown): unknown {
  if (typeof err === 'object' && err !== null) Object.assign(err, { [SESSION_STORE_ERROR]: true });
  return err;
}

/**
 * Tells whether an error means the session store is overloaded rather than broken: mysql2 rejects a
 * lookup straight away once the session pool's wait queue is full. The panel answers that with a
 * 503 instead of a 500.
 * @param err - The error handed to the error handler.
 * @returns true for mysql2's "Queue limit reached." rejection, marked by {@link markSessionStoreError}.
 */
export function isSessionStoreBusyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const marked = (err as { [SESSION_STORE_ERROR]?: unknown })[SESSION_STORE_ERROR] === true;
  return marked && (err as { message?: unknown }).message === 'Queue limit reached.';
}

/**
 * Generates a per-account rate-limit key using the Discord ID.
 * Each authenticated account gets its own bucket regardless of IP sharing.
 * The fallback is never reached in practice because sessionLimiterSkip
 * returns true for unauthenticated requests.
 * @param req - Express request object
 * @returns Discord ID for authenticated users, or "__unauthenticated__" fallback
 */
export function sessionLimiterKey(req: Request): string {
  return maybeSession(req)?.user?.discordId ?? '__unauthenticated__';
}

/**
 * Determines whether to skip the per-session rate limiter.
 * Only applies to authenticated, non-Streamdeck requests.
 * @param req - Express request object
 * @returns true if the session limiter should be skipped
 */
export function sessionLimiterSkip(req: Request): boolean {
  return req.path.startsWith('/api/streamdeck') || !maybeSession(req)?.user;
}

/**
 * Generates a rate-limit key for the Streamdeck API.
 * Keys by Bearer token so each API key gets its own bucket regardless of IP.
 * The token is SHA-256-hashed before use as the key so that plaintext API
 * tokens are never stored in the rate-limit store (e.g. in memory dumps).
 * Falls back to IP-based keying when no Bearer token is present.
 * @param req - Express request object
 * @returns SHA-256 hash of the Bearer token, or IP-based fallback key
 */
export function streamdeckLimiterKey(req: Request): string {
  const auth = req.headers['authorization'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) return createHash('sha256').update(token).digest('hex');
  return ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown');
}

/**
 * Decides whether a Streamdeck API response should be left uncounted by
 * {@link streamdeckAuthFailureLimiter}: everything except a 401 is "successful" for its purposes.
 * @param _req - Express request (unused).
 * @param res - Express response; reads `statusCode` once the response has finished.
 * @returns false only for a 401 (failed Bearer-token authentication), true otherwise.
 */
export function streamdeckAuthFailureWasSuccessful(_req: Request, res: Response): boolean {
  return res.statusCode !== 401;
}

/**
 * IP-keyed limiter on failed Streamdeck authentication, mounted before the token-keyed
 * `streamdeckLimiter`. That limiter keys on the raw Bearer token before it's verified (and
 * `/api/streamdeck` skips the general IP limiter), so a caller sending a fresh random token per
 * request would get a fresh bucket every time — each one still costing a SHA-256 plus a DB
 * lookup. Only 401 responses count here (`skipSuccessfulRequests` with
 * {@link streamdeckAuthFailureWasSuccessful}), so a valid key's normal traffic never touches
 * this bucket, while guessing from one IP is cut off after `limit` failures per window.
 */
export const streamdeckAuthFailureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: ipKey,
  skipSuccessfulRequests: true,
  requestWasSuccessful: streamdeckAuthFailureWasSuccessful,
  message: 'Too many failed authentication attempts, please try again later.',
  handler: limitReachedHandler('streamdeck-auth-failure'),
});

/** Most videos one account can add to the public overlay video library per window. */
export const LIBRARY_PUBLISH_LIMIT = 10;

/**
 * Per-account cap on adding videos to the public overlay video library (#907), applied to
 * `POST /overlay/settings/videos/:id/publish` after `requireAuth`. The session limiter's 600
 * requests per 15 minutes would still let one account fill the library with hundreds of entries
 * every Admin then has to remove by hand; nobody publishes more than a few videos at a time.
 * Keyed by Discord ID like the session limiter, so accounts behind one IP don't share a bucket.
 */
export const libraryPublishLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: LIBRARY_PUBLISH_LIMIT,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: sessionLimiterKey,
  message: 'Too many requests to add videos to the public library. Please try again in an hour.',
  handler: limitReachedHandler('library-publish'),
});

/** Most public library videos one account can import into its own videos per window. */
export const LIBRARY_IMPORT_LIMIT = 20;

/**
 * Per-account cap on importing public overlay library videos into the streamer's own videos
 * (#907), applied to `POST /overlay/settings/library/:id/import` after `requireAuth`. Importing
 * the same entry again is allowed (each import is a separate copy), so without this the session
 * limiter's 600 requests per 15 minutes would let one account add thousands of rows and files a
 * day — full copies where the library and streamer folders are on different filesystems. A total
 * per-streamer storage cap is #904's. Keyed by Discord ID like the session limiter.
 */
export const libraryImportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: LIBRARY_IMPORT_LIMIT,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: sessionLimiterKey,
  message: 'Too many requests to add library videos to your videos. Please try again in an hour.',
  handler: limitReachedHandler('library-import'),
});
