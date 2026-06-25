import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { consumeCode, issueToken } from '../../db';
import { renderError } from './shared';

const log = createLogger('CompanionAuth');
const router = Router();

const COMPANION_OAUTH_TTL_MS = 10 * 60 * 1000;

/**
 * Returns true if `redirectUri` is a loopback HTTP URL (127.0.0.1 or localhost,
 * any port). Per RFC 8252 §7.3, only loopback redirects are accepted for the
 * companion app's OAuth flow — anything else risks leaking the authorization
 * code to an attacker-controlled host.
 * @param redirectUri - The `redirect_uri` query parameter to validate.
 * @returns Whether the URI is a permitted loopback redirect target.
 */
function isLoopbackRedirectUri(redirectUri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
}

// GET /companion/login — entry point for the companion app's loopback OAuth flow.
// Validates the loopback redirect_uri, stashes it on the session, then hands off
// to the existing Discord OAuth login (the callback branches back here on success).
router.get('/companion/login', (req, res) => {
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

// POST /api/companion/oauth/token — exchanges a one-time authorization code (issued
// by the /auth/discord/callback companion branch) for a long-lived companion token.
router.post('/api/companion/oauth/token', async (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code || typeof code !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing code' });
    return;
  }

  try {
    const discordId = await consumeCode(code);
    if (!discordId) {
      res.status(400).json({ ok: false, error: 'Invalid or expired code' });
      return;
    }
    const token = await issueToken(discordId);
    res.json({ token });
  } catch (err) {
    log.error('Companion token exchange failed:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;
