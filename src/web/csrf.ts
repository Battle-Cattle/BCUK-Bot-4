import crypto from 'crypto';
import type { RequestHandler } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function createCsrfError(): Error & { code: string } {
  const error = new Error('Invalid CSRF token') as Error & { code: string };
  error.code = 'EBADCSRFTOKEN';
  return error;
}

export function ensureSessionCsrfToken(req: Parameters<RequestHandler>[0]): string {
  if (typeof req.session.csrfToken !== 'string' || req.session.csrfToken.length === 0) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  return req.session.csrfToken;
}

function getSubmittedCsrfToken(req: Parameters<RequestHandler>[0]): string | null {
  // Check header first so CSRF can be validated before multipart body parsing (e.g. file uploads).
  const header = req.headers['x-csrf-token'];
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }

  if (typeof req.body?._csrf === 'string') {
    return req.body._csrf;
  }

  return null;
}

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
