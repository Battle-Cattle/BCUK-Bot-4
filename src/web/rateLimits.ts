import { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

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
 * Falls back to IP-based keying when no Bearer token is present.
 * @param req - Express request object
 * @returns Bearer token value, or IP-based fallback key
 */
export function streamdeckLimiterKey(req: Request): string {
  const auth = req.headers['authorization'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  return token ?? ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
}
