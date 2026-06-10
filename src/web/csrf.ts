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
  // Query param checked first — available before multipart body parsing (Multer).
  if (typeof req.query?._csrf === 'string') return req.query._csrf;
  if (typeof req.body?._csrf === 'string') return req.body._csrf;
  const xcsrf = req.headers['x-csrf-token'];
  const header = (typeof xcsrf === 'string' && xcsrf.trim() !== '') ? xcsrf : req.headers['x-xsrf-token'];
  if (typeof header === 'string') return header;
  return null;
}

/**
 * Express middleware that enforces CSRF protection on all non-safe HTTP methods.
 * Safe methods (GET, HEAD, OPTIONS) pass through unconditionally.
 * Unsafe methods must supply a token matching the session's `csrfToken` via query
 * (`_csrf`), form body (`_csrf`), `X-CSRF-Token`, or `X-XSRF-Token` header.
 * Mismatches call `next` with an error bearing `code: 'EBADCSRFTOKEN'`.
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
