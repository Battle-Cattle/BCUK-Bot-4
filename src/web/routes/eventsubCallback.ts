import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getStreamerById, saveStreamerToken, initEventConfig, initAlertConfigs } from '../../db';
import { exchangeCode, getUserFromToken } from '../../twitch/eventsub/twitchApiEventSub';
import { TWITCH_EVENTSUB_REDIRECT_URI } from '../../shared/config';
import { reloadEventSubSubscriptions } from '../../twitch/eventsub/twitchEventSub';
import { clearAuthFailedSubs } from '../../twitch/eventsub/twitchEventSubSubscriptions';

const log = createLogger('Web');
const router = Router();

// GET /auth/twitch/eventsub/callback
// No requireAuth — Twitch redirects here outside the normal session flow.
// CSRF is handled via the session state set during OAuth initiation.

/**
 * GET /auth/twitch/eventsub/callback — completes the Twitch OAuth flow started by
 * `/user/twitch-connect`. Validates the OAuth state and streamer ownership, exchanges
 * the code for tokens, verifies the connecting Twitch account matches the expected
 * streamer login, saves the token, initializes the chat-message EventSub config and the
 * alerts-overlay config (`initAlertConfigs`), and reloads subscriptions.
 * @param req - Express request; reads `code`/`state`/`error` query params and the
 *   stored `eventsubOAuthState`/`eventsubStreamerId` session values.
 * @param res - Express response; redirects to `/user/settings?success=twitch_connected`
 *   on success, or to `/user/settings?error=<code>` if Twitch denied authorization
 *   (`error=eventsub_oauth_denied`), the OAuth state/streamer is missing or mismatched
 *   (`error=eventsub_oauth_state_mismatch`), config is missing (`error=eventsub_config_failed`),
 *   the streamer record can't be found (`error=invalid_id`), the token exchange fails
 *   (`error=eventsub_token_invalid`), the connecting account doesn't match the expected
 *   streamer (`error=eventsub_wrong_account`), or any other error occurs
 *   (`error=eventsub_config_failed`).
 */
router.get('/twitch/eventsub/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;

  const storedOAuth = req.session.eventsubOAuthState;
  const streamerId = req.session.eventsubStreamerId;

  // Clear state from session immediately to prevent replay — even on OAuth errors.
  delete req.session.eventsubOAuthState;
  delete req.session.eventsubStreamerId;

  if (error) {
    log.warn(`EventSub OAuth denied: ${error}`);
    return res.redirect('/user/settings?error=eventsub_oauth_denied');
  }

  if (!code || !state || !storedOAuth || !streamerId) {
    return res.redirect('/user/settings?error=eventsub_oauth_state_mismatch');
  }
  if (state !== storedOAuth.value || Date.now() > storedOAuth.expiresAt) {
    return res.redirect('/user/settings?error=eventsub_oauth_state_mismatch');
  }

  if (!TWITCH_EVENTSUB_REDIRECT_URI) {
    log.error('TWITCH_EVENTSUB_REDIRECT_URI is not configured');
    return res.redirect('/user/settings?error=eventsub_config_failed');
  }

  try {
    const streamer = await getStreamerById(streamerId);
    if (!streamer) return res.redirect('/user/settings?error=invalid_id');

    // If there is an authenticated session user, verify they own this streamer record before
    // consuming the one-time OAuth code. Prevents a shared-browser scenario where a different
    // user completes another's OAuth flow.
    const sessionUser = req.session.user;
    if (sessionUser && streamer.discord_id !== sessionUser.discordId) {
      log.warn(`EventSub OAuth user mismatch: session user ${sessionUser.discordId} does not own streamer ${streamerId}`);
      return res.redirect('/user/settings?error=eventsub_oauth_state_mismatch');
    }

    const tokens = await exchangeCode(code, TWITCH_EVENTSUB_REDIRECT_URI);
    const twitchUser = await getUserFromToken(tokens.access_token);
    if (!twitchUser) return res.redirect('/user/settings?error=eventsub_token_invalid');

    const expectedLogin = streamer.twitch_name?.toLowerCase();
    if (!expectedLogin || twitchUser.login.toLowerCase() !== expectedLogin) {
      log.warn(`EventSub OAuth mismatch: expected ${streamer.twitch_name ?? 'unknown'}, got ${twitchUser.login}`);
      return res.redirect(`/user/settings?error=eventsub_wrong_account&expected=${encodeURIComponent(streamer.twitch_name ?? '')}`);
    }

    const expiryMs = tokens.expires_in != null ? Date.now() + tokens.expires_in * 1000 - 60_000 : null;
    await saveStreamerToken(streamerId, twitchUser.id, tokens.access_token, tokens.refresh_token, expiryMs);
    await initEventConfig(streamerId);
    await initAlertConfigs(streamerId);
    clearAuthFailedSubs(twitchUser.login.toLowerCase());
    reloadEventSubSubscriptions();
    log.info(`EventSub OAuth connected for ${streamer.twitch_name}`);
    res.redirect('/user/settings?success=twitch_connected');
  } catch (err) {
    log.error('EventSub OAuth callback error:', err);
    res.redirect('/user/settings?error=eventsub_config_failed');
  }
});

export default router;
