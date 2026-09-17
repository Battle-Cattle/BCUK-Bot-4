import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { saveBotChatToken } from '../../db';
import { exchangeCode, getUserFromToken } from '../../twitch/eventsub/twitchApiEventSub';
import { TWITCH_BOT_OAUTH_REDIRECT_URI } from '../../shared/config';
import { logAndRedirectError } from './errorHandling';
import { oauthStateMatches } from '../csrf';

const log = createLogger('Web');
const router = Router();

// GET /auth/twitch/bot/callback
// No requireAuth/requireOwner — Twitch redirects here outside the normal session flow.
// CSRF is handled via the session state set during OAuth initiation in botAuth.ts.

/**
 * GET /auth/twitch/bot/callback — completes the Twitch OAuth flow started by
 * `/admin/bot-auth/connect` for the bot's own chat account. Validates the OAuth state,
 * exchanges the code for tokens, identifies the connecting Twitch account, and saves the
 * token (see issue #550).
 * @param req - Express request; reads `code`/`state`/`error` query params and the stored
 *   `botOAuthState` session value.
 * @param res - Express response; redirects to `/admin/bot-auth?success=bot_connected` on
 *   success, or to `/admin/bot-auth?error=<code>` if Twitch denied authorization
 *   (`error=bot_oauth_denied`), the OAuth state is missing or mismatched
 *   (`error=bot_oauth_state_mismatch`), config is missing or the token exchange fails
 *   (`error=bot_oauth_token_invalid`), or any other error occurs (`error=bot_oauth_config_failed`).
 */
router.get('/twitch/bot/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;

  const storedOAuth = req.session.botOAuthState;

  // Clear state from session immediately to prevent replay — even on OAuth errors.
  delete req.session.botOAuthState;

  if (error) {
    log.warn(`Bot chat OAuth denied: ${error}`);
    return res.redirect('/admin/bot-auth?error=bot_oauth_denied');
  }

  if (!code || !state || !storedOAuth) {
    return res.redirect('/admin/bot-auth?error=bot_oauth_state_mismatch');
  }
  if (!oauthStateMatches(state, storedOAuth.value) || Date.now() > storedOAuth.expiresAt) {
    return res.redirect('/admin/bot-auth?error=bot_oauth_state_mismatch');
  }

  if (!TWITCH_BOT_OAUTH_REDIRECT_URI) {
    log.error('TWITCH_BOT_OAUTH_REDIRECT_URI is not configured');
    return res.redirect('/admin/bot-auth?error=bot_oauth_config_failed');
  }

  try {
    const tokens = await exchangeCode(code, TWITCH_BOT_OAUTH_REDIRECT_URI);
    const twitchUser = await getUserFromToken(tokens.access_token);
    if (!twitchUser) return res.redirect('/admin/bot-auth?error=bot_oauth_token_invalid');

    const expiryMs = tokens.expires_in != null ? Date.now() + tokens.expires_in * 1000 - 60_000 : null;
    await saveBotChatToken(twitchUser.id, tokens.access_token, tokens.refresh_token, expiryMs);
    log.info(`Bot chat OAuth connected as ${twitchUser.login}`);
    res.redirect('/admin/bot-auth?success=bot_connected');
  } catch (err) {
    logAndRedirectError({
      res, log, logLabel: 'Bot chat OAuth callback error:', err, basePath: '/admin/bot-auth', errorCode: 'bot_oauth_config_failed',
    });
  }
});

export default router;
