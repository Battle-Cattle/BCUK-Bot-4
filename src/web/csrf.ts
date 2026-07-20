import crypto from 'crypto';
import type { RequestHandler } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function createCsrfError(): Error & { code: string } {
  const error = new Error('Invalid CSRF token') as Error & { code: string };
  error.code = 'EBADCSRFTOKEN';
  return error;
}

/**
 * Return the session's CSRF token, generating and storing a new one if absent.
 *
 * @param req - Express request with a `session` object attached.
 * @returns The 64-character hex CSRF token bound to this session.
 */
export function ensureSessionCsrfToken(req: Parameters<RequestHandler>[0]): string {
  if (typeof req.session.csrfToken !== 'string' || req.session.csrfToken.length === 0) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  return req.session.csrfToken;
}

function getSubmittedCsrfToken(req: Parameters<RequestHandler>[0]): string | null {
  if (typeof req.body?._csrf === 'string') return req.body._csrf;
  const xcsrf = req.headers['x-csrf-token'];
  const header = (typeof xcsrf === 'string' && xcsrf.trim() !== '') ? xcsrf : req.headers['x-xsrf-token'];
  if (typeof header === 'string') return header;
  return null;
}

/**
 * Express middleware that enforces CSRF protection on all non-safe HTTP methods.
 * Safe methods (GET, HEAD, OPTIONS) pass through unconditionally.
 *
 * For unsafe methods the submitted token is resolved in this priority order:
 * 1. Form/JSON body field `_csrf`
 * 2. `X-CSRF-Token` header (ignored when empty)
 * 3. `X-XSRF-Token` header
 *
 * The query string is deliberately not checked — a CSRF token placed in a URL
 * can leak via server access logs, browser history, and the `Referer` header
 * sent to third-party resources the page subsequently loads.
 *
 * The submitted token must match the session's `csrfToken` via constant-time
 * comparison. Mismatches call `next` with an error bearing `code: 'EBADCSRFTOKEN'`.
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  const sessionToken = ensureSessionCsrfToken(req);
  req.csrfToken = () => sessionToken;

  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const submittedToken = getSubmittedCsrfToken(req);
  if (!submittedToken) {
    next(createCsrfError());
    return;
  }

  // Compare hex digests so both buffers are always the same byte length,
  // eliminating any timing side-channel from a length mismatch check.
  const a = Buffer.from(crypto.createHash('sha256').update(submittedToken).digest('hex'));
  const b = Buffer.from(crypto.createHash('sha256').update(sessionToken).digest('hex'));
  if (!crypto.timingSafeEqual(a, b)) {
    next(createCsrfError());
    return;
  }

  next();
};
