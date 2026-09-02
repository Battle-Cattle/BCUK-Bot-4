import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { exchangeCodeForToken } from '../../db';
import { isLoopbackRedirectUri } from './validation';
import { renderError } from './viewHelpers';
import { authLimiter } from '../rateLimits';
import { disconnectCompanionConnections } from './companionEvents';

const log = createLogger('CompanionAuth');
const router = Router();

const COMPANION_OAUTH_TTL_MS = 10 * 60 * 1000;

/**
 * GET /companion/login — entry point for the companion app's loopback OAuth flow.
 * Validates the loopback redirect_uri, stashes it (with the app's state) on the
 * session, then hands off to the existing Discord OAuth login; the callback
 * branches back here on success and redirects to redirectUri with a one-time code.
 * Rate-limited by `authLimiter`, which responds 429 before this handler runs.
 * @param req.query.redirect_uri - Loopback URL the companion app is listening on.
 * @param req.query.state - Opaque value echoed back to the app for CSRF binding.
 */
router.get('/companion/login', authLimiter, (req, res) => {
  const { redirect_uri: redirectUri, state } = req.query as { redirect_uri?: string; state?: string };
  if (!redirectUri || !state || !isLoopbackRedirectUri(redirectUri)) {
    return renderError(res, 400, 'Invalid or missing loopback redirect_uri/state.', undefined);
  }

  req.session.companionOAuth = {
    redirectUri,
    appState: state,
    expiresAt: Date.now() + COMPANION_OAUTH_TTL_MS,
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
 * @returns `{ token }` on success, or a 400/429/500 JSON error response —
 *   429 comes from `authLimiter` and short-circuits before this handler runs.
 */
router.post('/api/companion/oauth/token', authLimiter, async (req, res) => {
  const { code } = (req.body ?? {}) as { code?: string };
  if (!code || typeof code !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing code' });
    return;
  }

  try {
    const result = await exchangeCodeForToken(code);
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

export default router;
