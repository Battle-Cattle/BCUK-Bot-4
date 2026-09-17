import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { randomBytes } from 'crypto';
import { getBotChatToken } from '../../db';
import { getUserFromToken } from '../../twitch/eventsub/twitchApiEventSub';
import { TWITCH_CLIENT_ID, TWITCH_BOT_OAUTH_REDIRECT_URI, EVENTSUB_TOKEN_SECRET } from '../../shared/config';
import { requireOwner } from '../middleware';
import { csrfProtection } from '../csrf';
import { renderView, renderError, getFriendlyErrorMessage } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';

const log = createLogger('Web');
const router = Router();

/** Scope requested for the bot's own chat account — modern Twurple `ChatClient` scopes, replacing the legacy static token's `chat_login` scope (see issue #550). */
const TWITCH_BOT_OAUTH_SCOPE = 'chat:read chat:edit';

const KNOWN_ERRORS = new Set([
  'bot_oauth_denied',
  'bot_oauth_state_mismatch',
  'bot_oauth_token_invalid',
  'bot_oauth_config_failed',
]);
const KNOWN_SUCCESSES = new Set(['bot_connected']);

const ERROR_MESSAGES: Record<string, string> = {
  bot_oauth_denied:         'Twitch authorization was denied.',
  bot_oauth_state_mismatch: 'Authorization failed — please try connecting again.',
  bot_oauth_token_invalid:  'Could not verify the connected Twitch account. Please try again.',
  bot_oauth_config_failed:  'Failed to save the bot chat token. Please try again.',
};

/** Looks up a `botAuth` page error code in {@link ERROR_MESSAGES}, for use as an EJS template helper. */
function getFriendlyError(key: string): string {
  return getFriendlyErrorMessage(ERROR_MESSAGES, key);
}

/** Query-param filter mirroring `validation.ts`'s `filterQueryParam` for this route's small, page-local known-value sets. */
function filterKnown(value: unknown, known: Set<string>): string | undefined {
  return typeof value === 'string' && known.has(value) ? value : undefined;
}

// GET /admin/bot-auth

/**
 * GET /admin/bot-auth — renders the owner-only page for connecting/viewing the Twitch chat
 * bot's own OAuth-connected account (see issue #550). Shows whether an account is currently
 * connected (and which one, re-validated live via `getUserFromToken` rather than trusting the
 * stored `twitch_user_id` alone) plus a connect button, and any `error`/`success` banner from
 * a prior redirect.
 * @param req - Express request; reads `req.session.user`, `error`, and `success` query params.
 * @param res - Express response; renders the `botAuth` view, or a 500 error page if loading
 *   the current connection status fails.
 */
router.get('/', requireOwner, csrfProtection, async (req, res) => {
  try {
    const stored = await getBotChatToken();
    let connectedLogin: string | null = null;
    if (stored) {
      const twitchUser = await getUserFromToken(stored.accessToken);
      connectedLogin = twitchUser?.login ?? null;
    }

    renderView(res, 'botAuth', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      isConnected: !!stored,
      connectedLogin,
      error: filterKnown(req.query.error, KNOWN_ERRORS),
      success: filterKnown(req.query.success, KNOWN_SUCCESSES),
      getFriendlyError,
    });
  } catch (err) {
    log.error('Bot auth page error:', err);
    renderError(res, 500, 'Failed to load bot connection status.', req.session.user);
  }
});

// GET /admin/bot-auth/connect — initiates Twitch OAuth for the bot's own chat account

/**
 * GET /admin/bot-auth/connect — starts the Twitch OAuth flow for the bot's own chat account.
 * Stores the OAuth state on the session, then redirects to Twitch's authorize URL requesting
 * `chat:read chat:edit` scope.
 * @param req - Express request; writes `botOAuthState` to the session for the callback.
 * @param res - Express response; redirects to id.twitch.tv's OAuth2 authorize endpoint on
 *   success, or to `/admin/bot-auth?error=bot_oauth_config_failed` if required config is missing.
 */
router.get('/connect', requireOwner, (req, res) => {
  try {
    if (!TWITCH_CLIENT_ID || !TWITCH_BOT_OAUTH_REDIRECT_URI || !EVENTSUB_TOKEN_SECRET) {
      log.error('TWITCH_CLIENT_ID, TWITCH_BOT_OAUTH_REDIRECT_URI, or EVENTSUB_TOKEN_SECRET is not configured');
      return res.redirect('/admin/bot-auth?error=bot_oauth_config_failed');
    }

    const state = randomBytes(16).toString('hex');
    req.session.botOAuthState = { value: state, expiresAt: Date.now() + 10 * 60 * 1000 };

    const params = new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      redirect_uri: TWITCH_BOT_OAUTH_REDIRECT_URI,
      response_type: 'code',
      scope: TWITCH_BOT_OAUTH_SCOPE,
      state,
      force_verify: 'true',
    });

    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Bot chat connect error:', err, basePath: '/admin/bot-auth', errorCode: 'bot_oauth_config_failed' });
  }
});

export default router;
