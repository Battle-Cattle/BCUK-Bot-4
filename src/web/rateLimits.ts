import { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

export function ipKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
}

/** generalLimiter skip — bypasses the IP bucket for session users (covered by
 *  sessionLimiter) and for the Streamdeck API (its own token-keyed limiter). */
export function generalLimiterSkip(req: Request): boolean {
  return req.path.startsWith('/api/streamdeck') || !!req.session?.user;
}

/** sessionLimiter keyGenerator — keys by Discord ID so each account gets its
 *  own bucket regardless of IP sharing. The fallback is never reached in
 *  practice because sessionLimiter.skip returns true for unauthenticated reqs. */
export function sessionLimiterKey(req: Request): string {
  return req.session?.user?.discordId ?? '__unauthenticated__';
}

/** sessionLimiter skip — only applies to authenticated, non-Streamdeck requests. */
export function sessionLimiterSkip(req: Request): boolean {
  return req.path.startsWith('/api/streamdeck') || !req.session?.user;
}

/** streamdeckLimiter keyGenerator — keys by Bearer token so each API key gets
 *  its own bucket regardless of which IP the request originates from. */
export function streamdeckLimiterKey(req: Request): string {
  const auth = req.headers['authorization'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  return token ?? ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
}
