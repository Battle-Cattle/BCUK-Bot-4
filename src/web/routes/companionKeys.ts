import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { issueToken, getTokenStatus, revokeToken } from '../../db';
import { csrfProtection } from '../csrf';
import { filterQueryParam } from './validation';
import { renderError, renderView } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';
import { getSessionUser } from '../session';
import { disconnectCompanionConnections } from './companionEvents';

const log = createLogger('Web');
const router = Router();

const KNOWN_ERRORS = new Set(['request_failed', 'revoke_failed']);

interface RecentIssue {
  plain: string;
  issuedAt: number;
}

// Tracks a just-issued token per discordId for a short window, so a rapid duplicate POST
// /companion-key/request (double-click, browser retry/refresh) reuses the plaintext already
// rendered instead of issuing again — issuing unconditionally replaces the prior token and
// disconnects any open companion SSE connection, so a duplicate submit would otherwise silently
// invalidate the token the user was just shown. Same pattern as streamdeckKeys.ts's
// ROTATE_DEDUPE_WINDOW_MS/recentRotations. Entries expire lazily by age and are actively evicted
// via a guarded timer once expired, so a plaintext token never lingers in process memory longer
// than the dedupe window.
const ISSUE_DEDUPE_WINDOW_MS = 10_000;
const recentIssues = new Map<string, RecentIssue>();

// Coalesces concurrent issuances for the same discordId onto a single `issueToken` call.
// `recentIssues` is only populated once an issuance resolves, so two requests arriving before
// either finishes would otherwise both call `issueToken` — which upserts by discord_id, so the
// second call's write silently replaces the first's token before the first request ever got to
// cache (or render) it, handing that caller an already-invalidated plaintext.
const inFlightIssues = new Map<string, Promise<string>>();

/** Test-only: clears the issue dedupe cache so each test starts from a clean slate. */
export function __resetRecentIssuesForTests(): void {
  recentIssues.clear();
  inFlightIssues.clear();
}

/**
 * Issues a fresh companion token for `discordId`, disconnects any SSE connections open under
 * the token it replaces, and caches the result in {@link recentIssues} for
 * {@link ISSUE_DEDUPE_WINDOW_MS}. Concurrent callers for the same `discordId` share one
 * in-flight call instead of each issuing (and invalidating) their own — see {@link inFlightIssues}.
 * @param discordId - Discord ID to issue a token for.
 * @returns The newly issued plaintext token.
 */
function issueAndCacheToken(discordId: string): Promise<string> {
  const inFlight = inFlightIssues.get(discordId);
  if (inFlight) return inFlight;

  const issuance = (async (): Promise<string> => {
    try {
      const plain = await issueToken(discordId);
      disconnectCompanionConnections(discordId);
      const result: RecentIssue = { plain, issuedAt: Date.now() };
      recentIssues.set(discordId, result);
      setTimeout(() => {
        if (recentIssues.get(discordId) === result) recentIssues.delete(discordId);
      }, ISSUE_DEDUPE_WINDOW_MS).unref();
      return plain;
    } finally {
      inFlightIssues.delete(discordId);
    }
  })();
  inFlightIssues.set(discordId, issuance);
  return issuance;
}

/** Renders the current user's companion app token status page. */
router.get('/companion-key', csrfProtection, async (req, res) => {
  try {
    const tokenStatus = await getTokenStatus(getSessionUser(req).discordId);
    renderView(res, 'companion-keys', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      tokenStatus,
      newToken: null,
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
    });
  } catch (err) {
    log.error('Companion key page error:', err);
    renderError(res, 500, 'Failed to load companion app token status.', req.session.user);
  }
});

/**
 * Issues (or replaces) a companion app token for the current user — manual fallback
 * to the OAuth login flow. Only this section's failure can burn the user's one
 * chance to see the new plaintext token, so the follow-up status refresh runs in
 * its own try/catch with a locally-derived fallback rather than risking the
 * already-issued token being lost behind a `request_failed` redirect. Issuing a
 * token replaces (invalidates) any prior one for this Discord ID, so this also ends
 * any companion SSE connection still open under the token just replaced. A request within
 * {@link ISSUE_DEDUPE_WINDOW_MS} of the last one for this user reuses that plaintext instead of
 * issuing (and invalidating) again — see {@link recentIssues}.
 */
router.post('/companion-key/request', csrfProtection, async (req, res) => {
  const discordId = getSessionUser(req).discordId;
  let plain: string;
  try {
    const recent = recentIssues.get(discordId);
    plain = recent && Date.now() - recent.issuedAt < ISSUE_DEDUPE_WINDOW_MS
      ? recent.plain
      : await issueAndCacheToken(discordId);
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Companion key request error:', err, basePath: '/companion-key', errorCode: 'request_failed' });
    return;
  }

  let tokenStatus;
  try {
    tokenStatus = await getTokenStatus(discordId);
  } catch (err) {
    log.error('Companion key status refresh after issue failed:', err);
    tokenStatus = { hasToken: true, createdAt: new Date() };
  }

  renderView(res, 'companion-keys', {
    user: req.session.user,
    csrfToken: req.csrfToken(),
    tokenStatus,
    newToken: plain,
    error: null,
  });
});

/**
 * Revokes the current user's companion app token, and immediately ends any of their companion
 * app's open SSE connections (see `disconnectCompanionConnections`) — otherwise a connection
 * opened before the revoke would keep receiving events until it happened to disconnect on its
 * own, since `requireCompanionKey` only checks the token once, at connect time.
 */
router.post('/companion-key/revoke', csrfProtection, async (req, res) => {
  try {
    const discordId = getSessionUser(req).discordId;
    await revokeToken(discordId);
    disconnectCompanionConnections(discordId);
    recentIssues.delete(discordId);
    res.redirect('/companion-key');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Companion key revoke error:', err, basePath: '/companion-key', errorCode: 'revoke_failed' });
  }
});

export default router;
