import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { exchangeCodeForToken, revokeToken } from '../../db';
import { isLoopbackRedirectUri } from './validation';
import { renderError } from './viewHelpers';
import { authLimiter } from '../rateLimits';
import { disconnectCompanionConnections } from './companionEvents';
import { requireCompanionKey } from '../middleware';

const log = createLogger('CompanionAuth');
const router = Router();

const COMPANION_OAUTH_TTL_MS = 10 * 60 * 1000;

/** A PKCE S256 challenge: base64url (no padding) of a SHA-256, always 43 characters (RFC 7636 §4.2). */
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A PKCE code verifier: 43-128 unreserved characters (RFC 7636 §4.1). */
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/**
 * Reads the optional PKCE parameters from `/companion/login`. Only S256 is accepted: `plain`
 * would send the verifier itself through the browser, which is what PKCE exists to avoid.
 * @param query - The request query.
 * @returns The challenge, null when the app sent none (an app that predates PKCE), or undefined
 *   when the parameters are present but invalid.
 */
function parsePkceChallenge(query: Record<string, unknown>): string | null | undefined {
  const { code_challenge: challenge, code_challenge_method: method } = query;
  if (challenge === undefined && method === undefined) return null;
  if (method !== 'S256' || typeof challenge !== 'string' || !PKCE_CHALLENGE_PATTERN.test(challenge)) return undefined;
  return challenge;
}

/**
 * GET /companion/login — entry point for the companion app's loopback OAuth flow.
 * Validates the loopback redirect_uri, stashes it (with the app's state) on the
 * session, then hands off to the existing Discord OAuth login; the callback
 * branches back here on success and redirects to redirectUri with a one-time code.
 * Rate-limited by `authLimiter`, which responds 429 before this handler runs.
 * @param req.query.redirect_uri - Loopback URL the companion app is listening on.
 * @param req.query.state - Opaque value echoed back to the app for CSRF binding.
 * @param req.query.code_challenge - Optional PKCE S256 challenge; the token exchange then needs
 *   the matching `code_verifier`. Sent with `code_challenge_method=S256`.
 */
router.get('/companion/login', authLimiter, (req, res) => {
  const { redirect_uri: redirectUri, state } = req.query as { redirect_uri?: string; state?: string };
  if (!redirectUri || !state || !isLoopbackRedirectUri(redirectUri)) {
    return renderError(res, 400, 'Invalid or missing loopback redirect_uri/state.', undefined);
  }
  const codeChallenge = parsePkceChallenge(req.query);
  if (codeChallenge === undefined) {
    return renderError(res, 400, 'Invalid code_challenge: only an S256 challenge is supported.', undefined);
  }

  req.session.companionOAuth = {
    redirectUri,
    appState: state,
    expiresAt: Date.now() + COMPANION_OAUTH_TTL_MS,
    ...(codeChallenge ? { codeChallenge } : {}),
  };

  res.redirect('/auth/discord');
});

/**
 * POST /api/companion/oauth/token — exchanges a one-time authorization code (issued
 * by the /auth/discord/callback companion branch) for a long-lived companion token.
 * The exchange runs in a single DB transaction (see `exchangeCodeForToken`), so a
 * failure issuing the token doesn't permanently burn the one-time code. Since issuing
 * a token replaces (invalidates) any prior one for the same Discord ID, this also ends
 * any companion SSE connection still open under the token just replaced — otherwise it
 * would keep streaming under a token that's no longer valid for new connections.
 * @param req.body.code - Plaintext one-time code from the loopback redirect.
 * @param req.body.code_verifier - The PKCE verifier, required when the login sent a challenge.
 * @returns `{ token }` on success, or a 400/429/500 JSON error response —
 *   429 comes from `authLimiter` and short-circuits before this handler runs.
 */
router.post('/api/companion/oauth/token', authLimiter, async (req, res) => {
  const { code, code_verifier: codeVerifier } = (req.body ?? {}) as { code?: unknown; code_verifier?: unknown };
  if (!code || typeof code !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing code' });
    return;
  }
  if (codeVerifier !== undefined && (typeof codeVerifier !== 'string' || !PKCE_VERIFIER_PATTERN.test(codeVerifier))) {
    res.status(400).json({ ok: false, error: 'Invalid code_verifier' });
    return;
  }

  try {
    const result = await exchangeCodeForToken(code, codeVerifier ?? null);
    if (!result) {
      res.status(400).json({ ok: false, error: 'Invalid or expired code' });
      return;
    }
    disconnectCompanionConnections(result.discordId);
    res.json({ token: result.token });
  } catch (err) {
    log.error('Companion token exchange failed:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});


/**
 * POST /api/companion/token/revoke — the companion app logging out revokes the token it
 * authenticated with, so a copy of it stops working too, and ends any SSE connection still open
 * under it. Bearer-authenticated by `requireCompanionKey`, so only an active token can revoke
 * itself (each user has one companion token at a time).
 * @param req - Express request; `req.companionDiscordId` is set by `requireCompanionKey`.
 * @param res - `{ ok: true }`, 401 from `requireCompanionKey` for an unknown or already-revoked
 *   token, or 500 on a DB error.
 */
router.post('/api/companion/token/revoke', authLimiter, requireCompanionKey, async (req, res) => {
  try {
    await revokeToken(req.companionDiscordId!);
    disconnectCompanionConnections(req.companionDiscordId!);
    res.json({ ok: true });
  } catch (err) {
    log.error('Companion token revoke failed:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;
