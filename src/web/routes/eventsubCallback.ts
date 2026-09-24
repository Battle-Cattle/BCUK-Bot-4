import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getStreamerById, saveStreamerToken, initEventConfig, initAlertConfigs } from '../../db';
import { exchangeCode, getUserFromToken } from '../../twitch/eventsub/twitchApiEventSub';
import { TWITCH_EVENTSUB_REDIRECT_URI } from '../../shared/config';
import { reloadEventSubSubscriptions } from '../../twitch/eventsub/twitchEventSub';
import { clearAuthFailedSubs } from '../../twitch/eventsub/twitchEventSubSubscriptions';
import { logAndRedirectError } from './errorHandling';
import { oauthStateMatches } from '../csrf';

const log = createLogger('Web');
const router = Router();

type OAuthCallbackCheck =
  | { ok: true; code: string; streamerId: number; redirectUri: string }
  | { ok: false; errorCode: 'eventsub_oauth_denied' | 'eventsub_oauth_state_mismatch' | 'eventsub_config_failed' };

/**
 * Validates the pre-token-exchange parts of the EventSub OAuth callback: Twitch didn't deny
 * authorization, the code/state/session values are all present, the returned state matches the
 * stored one and hasn't expired, and the redirect URI is configured.
 * @param query - The callback's `code`/`state`/`error` query params.
 * @param storedOAuth - The OAuth state stored in the session when the flow started.
 * @param streamerId - The streamer id stored in the session when the flow started.
 * @returns The values needed to continue the flow, or the error code to redirect with.
 */
export function validateOAuthCallback(
  query: { code?: string; state?: string; error?: string },
  storedOAuth: { value: string; expiresAt: number } | undefined,
  streamerId: number | undefined,
): OAuthCallbackCheck {
  if (query.error) {
    log.warn(`EventSub OAuth denied: ${query.error}`);
    return { ok: false, errorCode: 'eventsub_oauth_denied' };
  }
  const { code, state } = query;
  if (!code || !state || !storedOAuth || !streamerId) return { ok: false, errorCode: 'eventsub_oauth_state_mismatch' };
  if (!oauthStateMatches(state, storedOAuth.value) || Date.now() > storedOAuth.expiresAt) {
    return { ok: false, errorCode: 'eventsub_oauth_state_mismatch' };
  }
  if (!TWITCH_EVENTSUB_REDIRECT_URI) {
    log.error('TWITCH_EVENTSUB_REDIRECT_URI is not configured');
    return { ok: false, errorCode: 'eventsub_config_failed' };
  }
  return { ok: true, code, streamerId, redirectUri: TWITCH_EVENTSUB_REDIRECT_URI };
}

/**
 * Checks that the Twitch account that completed OAuth is the streamer's configured channel.
 * @param expectedName - The streamer record's `twitch_name`, or null if unset.
 * @param actualLogin - The login of the Twitch account the token belongs to.
 * @returns True only if the streamer has a Twitch name and it matches `actualLogin` (case-insensitive).
 */
export function isExpectedTwitchAccount(expectedName: string | null, actualLogin: string): boolean {
  return !!expectedName && expectedName.toLowerCase() === actualLogin.toLowerCase();
}

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

  const checked = validateOAuthCallback({ code, state, error }, storedOAuth, streamerId);
  if (!checked.ok) return res.redirect(`/user/settings?error=${checked.errorCode}`);

  try {
    const streamer = await getStreamerById(checked.streamerId);
    if (!streamer) return res.redirect('/user/settings?error=invalid_id');

    // If there is an authenticated session user, verify they own this streamer record before
    // consuming the one-time OAuth code. Prevents a shared-browser scenario where a different
    // user completes another's OAuth flow.
    const sessionUser = req.session.user;
    if (sessionUser && streamer.discord_id !== sessionUser.discordId) {
      log.warn(`EventSub OAuth user mismatch: session user ${sessionUser.discordId} does not own streamer ${checked.streamerId}`);
      return res.redirect('/user/settings?error=eventsub_oauth_state_mismatch');
    }

    const tokens = await exchangeCode(checked.code, checked.redirectUri);
    const twitchUser = await getUserFromToken(tokens.access_token);
    if (!twitchUser) return res.redirect('/user/settings?error=eventsub_token_invalid');

    if (!isExpectedTwitchAccount(streamer.twitch_name, twitchUser.login)) {
      log.warn(`EventSub OAuth mismatch: expected ${streamer.twitch_name ?? 'unknown'}, got ${twitchUser.login}`);
      return res.redirect(`/user/settings?error=eventsub_wrong_account&expected=${encodeURIComponent(streamer.twitch_name ?? '')}`);
    }

    const expiryMs = tokens.expires_in != null ? Date.now() + tokens.expires_in * 1000 - 60_000 : null;
    await saveStreamerToken(checked.streamerId, twitchUser.id, tokens.access_token, tokens.refresh_token, expiryMs);
    await initEventConfig(checked.streamerId);
    await initAlertConfigs(checked.streamerId);
    clearAuthFailedSubs(twitchUser.login.toLowerCase());
    reloadEventSubSubscriptions();
    log.info(`EventSub OAuth connected for ${streamer.twitch_name}`);
    res.redirect('/user/settings?success=twitch_connected');
  } catch (err) {
    logAndRedirectError({
      res, log, logLabel: 'EventSub OAuth callback error:', err, basePath: '/user/settings', errorCode: 'eventsub_config_failed',
    });
  }
});

export default router;
