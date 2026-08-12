import crypto from 'crypto';
import type { RequestHandler } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Session tokens are always 64 lowercase hex chars (crypto.randomBytes(32).toString('hex')).
const CSRF_TOKEN_HEX_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Converts a CSRF token to a 32-byte buffer for constant-time comparison, or null if it isn't
 * valid 64-char hex (an attacker-controlled submitted token can be any string). Format-checking
 * the length here doesn't leak anything security-relevant — a CSRF token's expected length is
 * public knowledge, not part of the secret — so this is just a cheap pre-check to guarantee both
 * buffers passed to `timingSafeEqual` are always the same length, without hashing either token.
 */
function csrfTokenBuffer(token: string): Buffer | null {
  return CSRF_TOKEN_HEX_PATTERN.test(token) ? Buffer.from(token, 'hex') : null;
}

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

  const submittedBuffer = csrfTokenBuffer(submittedToken);
  const sessionBuffer = csrfTokenBuffer(sessionToken);
  if (!submittedBuffer || !sessionBuffer || !crypto.timingSafeEqual(submittedBuffer, sessionBuffer)) {
    next(createCsrfError());
    return;
  }

  next();
};
