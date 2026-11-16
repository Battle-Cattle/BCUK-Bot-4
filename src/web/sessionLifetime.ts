// How long a web panel session lasts (#981): 24 hours since the last page load, and never more
// than 7 days since login. Background requests (the dashboard's refreshes, live connections) don't
// renew it, so a tab left open still logs out a day after it was last used.
import type { NextFunction, Request, Response } from 'express';
import type { SessionData } from 'express-session';
import { promisify } from 'util';
import { markSessionStoreError } from './rateLimits';

/** Idle timeout: a session ends this long after its last page load (the cookie's `maxAge`). */
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

/** Absolute cap: a session ends this long after login however active it is (decided 2026-11-11). */
export const SESSION_ABSOLUTE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A page load renews the session at most this often, so clicking around the panel doesn't write
 * the session row on every page. The cookie can end up to this much earlier than a full 24 hours
 * after the very last page load.
 */
export const SESSION_RENEW_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Tells whether a request is the browser loading a page (a top-level navigation), as opposed to a
 * `fetch()`, `EventSource`, image or script request, none of which send `Sec-Fetch-Mode: navigate`.
 * A browser that sends no `Sec-Fetch-*` headers never counts as loading a page.
 * @param req - Express request.
 * @returns True for a top-level page load.
 */
export function isPageLoad(req: Request): boolean {
  return req.get('sec-fetch-mode') === 'navigate' && (req.get('sec-fetch-dest') ?? 'document') === 'document';
}

/**
 * Tells whether a logged-in session has run out: past the absolute cap since login, or idle for
 * longer than the idle timeout since its last renewing page load. A session from before #981 has
 * neither time recorded and is left to its cookie's own expiry.
 * @param session - The request's session data.
 * @param now - Current time, ms since the epoch.
 * @returns True when the session must end.
 */
export function isSessionPastLifetime(session: Partial<SessionData>, now: number): boolean {
  if (session.loginAt !== undefined && now - session.loginAt > SESSION_ABSOLUTE_MAX_MS) return true;
  return session.lastSeenAt !== undefined && now - session.lastSeenAt > SESSION_IDLE_MS;
}

/**
 * Records a fresh login's times on the session, so the absolute cap and idle timeout count from now.
 * @param session - The newly regenerated session.
 * @param now - Login time, ms since the epoch.
 */
export function startSessionLifetime(session: Partial<SessionData>, now: number): void {
  session.loginAt = now;
  session.lastSeenAt = now;
}

/**
 * Renews a session on a page load: updating `lastSeenAt` marks it modified, so express-session
 * re-sends the cookie with a fresh {@link SESSION_IDLE_MS} expiry and saves the row with the same
 * expiry. A session from before #981 gets its login time set here, so its absolute cap counts from
 * its first page load after the deploy.
 * @param session - The request's session data.
 * @param now - Current time, ms since the epoch.
 */
function renewSession(session: Partial<SessionData>, now: number): void {
  if (session.lastSeenAt !== undefined && now - session.lastSeenAt < SESSION_RENEW_INTERVAL_MS) return;
  session.loginAt ??= now;
  session.lastSeenAt = now;
}

/**
 * Express middleware, run straight after the session middleware: ends a logged-in session that is
 * past its lifetime (see {@link isSessionPastLifetime}) and renews one on a page load (see
 * {@link isPageLoad}). Requests without a logged-in session pass straight through.
 * @param req - Express request with its session loaded.
 * @param _res - Express response (unused).
 * @param next - Continues the chain, with a session-store error if ending the session failed.
 * @returns Resolves once the request has been passed on.
 */
export async function enforceSessionLifetime(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.session.user) return next();
  const now = Date.now();
  if (isSessionPastLifetime(req.session, now)) {
    // Swaps the session for a fresh, empty one (deleting the old row), so the request carries on
    // logged out: a page redirects to login and `/api` answers 401.
    try {
      await promisify(req.session.regenerate.bind(req.session))();
    } catch (err) {
      return next(markSessionStoreError(err));
    }
    return next();
  }
  if (isPageLoad(req)) renewSession(req.session, now);
  next();
}
