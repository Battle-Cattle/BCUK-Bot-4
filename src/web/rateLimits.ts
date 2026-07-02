import { createHash } from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

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
  return ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
}

/**
 * Determines whether to skip the general IP-based rate limiter.
 * Skips for authenticated session users (covered by sessionLimiter) and
 * for the Streamdeck API (its own token-keyed limiter).
 * @param req - Express request object
 * @returns true if the general limiter should be skipped
 */
export function generalLimiterSkip(req: Request): boolean {
  return req.path.startsWith('/api/streamdeck') || !!req.session?.user;
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
  return req.session?.user?.discordId ?? '__unauthenticated__';
}

/**
 * Determines whether to skip the per-session rate limiter.
 * Only applies to authenticated, non-Streamdeck requests.
 * @param req - Express request object
 * @returns true if the session limiter should be skipped
 */
export function sessionLimiterSkip(req: Request): boolean {
  return req.path.startsWith('/api/streamdeck') || !req.session?.user;
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
  return ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
}
