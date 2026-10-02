import { createHash } from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response } from 'express';

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
});
