import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { issueToken, getTokenStatus, revokeToken } from '../../db';
import { csrfProtection } from '../csrf';
import { filterQueryParam } from './validation';
import { renderError, renderView } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';
import { getSessionUser } from '../session';
import { disconnectCompanionConnections } from './companionEvents';
import { createMutationQueue } from '../../shared/mutationQueue';

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

// Serializes issue/revoke per discordId. Both the dedupe check and the issue/revoke itself run
// inside a queued operation, so: (1) two concurrent issue requests can't both miss the cache and
// each call `issueToken` — the second runs only after the first has cached its result, and then
// reuses it; (2) a revoke racing an in-flight issuance always runs after that issuance settles,
// so it can't be undone by the issuance's own (now-stale) cache write completing afterward.
const tokenMutationQueue = createMutationQueue<string>();

/** Test-only: clears the issue dedupe cache so each test starts from a clean slate. */
export function __resetRecentIssuesForTests(): void {
  recentIssues.clear();
}

/**
 * Returns a usable companion token for `discordId`: the cached plaintext if one was issued
 * within {@link ISSUE_DEDUPE_WINDOW_MS}, otherwise a freshly issued one. Runs inside
 * {@link tokenMutationQueue} so this check-then-issue is atomic with respect to concurrent
 * issuances and revokes for the same `discordId` — see {@link tokenMutationQueue}.
 * @param discordId - Discord ID to get or issue a token for.
 * @returns The (cached or newly issued) plaintext token.
 */
function getOrIssueToken(discordId: string): Promise<string> {
  return tokenMutationQueue.run(discordId, async () => {
    const recent = recentIssues.get(discordId);
    if (recent && Date.now() - recent.issuedAt < ISSUE_DEDUPE_WINDOW_MS) {
      return recent.plain;
    }
    const plain = await issueToken(discordId);
    disconnectCompanionConnections(discordId);
    const result: RecentIssue = { plain, issuedAt: Date.now() };
    recentIssues.set(discordId, result);
    setTimeout(() => {
      if (recentIssues.get(discordId) === result) recentIssues.delete(discordId);
    }, ISSUE_DEDUPE_WINDOW_MS).unref();
    return plain;
  });
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
 * issuing (and invalidating) again — see {@link getOrIssueToken}.
 */
router.post('/companion-key/request', csrfProtection, async (req, res) => {
  const discordId = getSessionUser(req).discordId;
  let plain: string;
  try {
    plain = await getOrIssueToken(discordId);
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
 * own, since `requireCompanionKey` only checks the token once, at connect time. Runs inside
 * {@link tokenMutationQueue} so a revoke racing an in-flight issuance for this Discord ID always
 * runs after that issuance settles, rather than risk being undone by it.
 */
router.post('/companion-key/revoke', csrfProtection, async (req, res) => {
  try {
    const discordId = getSessionUser(req).discordId;
    await tokenMutationQueue.run(discordId, async () => {
      await revokeToken(discordId);
      disconnectCompanionConnections(discordId);
      recentIssues.delete(discordId);
    });
    res.redirect('/companion-key');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Companion key revoke error:', err, basePath: '/companion-key', errorCode: 'revoke_failed' });
  }
});

export default router;
