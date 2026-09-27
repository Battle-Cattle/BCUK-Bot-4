import { createLogger } from '../../shared/logger';
import { Router, type Request, type Response } from 'express';
import { getBotChatToken, saveBotChatTokenIfLatestAttempt, restoreBotChatTokenIfOwnedByConnection, type BotChatToken } from '../../db';
import { exchangeCode, getUserFromToken } from '../../twitch/eventsub/twitchApiEventSub';
import { restartTwitchBot } from '../../twitch/twitchBot';
import { TWITCH_BOT_OAUTH_REDIRECT_URI } from '../../shared/config';
import { logAndRedirectError } from './errorHandling';
import { oauthStateMatches } from '../csrf';

const log = createLogger('Web');
const router = Router();

// GET /auth/twitch/bot/callback
// No requireAuth/requireOwner — Twitch redirects here outside the normal session flow.
// CSRF is handled via the session state set during OAuth initiation in botAuth.ts.

/**
 * Best-effort restore of `previous` — the token that was live before this callback overwrote it —
 * after `restartTwitchBot()` fails to start chat on the newly connected account. Restores it via
 * {@link restoreBotChatTokenIfOwnedByConnection}, CAS'd against `newConnectionId` (the row's
 * `connection_id` right after this callback's own save won) rather than re-entering
 * {@link saveBotChatTokenIfLatestAttempt}'s attempt-ordering: a rollback isn't itself a competing,
 * owner-initiated connect attempt, so it must not be able to outrank — or be outranked by — a
 * legitimately newer, still-in-flight connect attempt on the *same* ordering axis. If the row has
 * since moved past `newConnectionId` (a newer connect attempt already saved over it), the rollback
 * correctly declines rather than clobbering that newer attempt. Never throws: any failure here just
 * means the caller's existing `chat_start_failed` warning path applies instead, leaving the (also
 * non-working) new token in place rather than looping further.
 * @param newConnectionId - The `connection_id` this callback's own save installed.
 * @param previous - The token active before this callback's save, or null if none was connected yet.
 * @returns True if the previous connection was restored and is running again.
 */
async function tryRestorePreviousConnection(newConnectionId: number, previous: BotChatToken | null): Promise<boolean> {
  if (!previous) return false;
  try {
    const restored = await restoreBotChatTokenIfOwnedByConnection(
      newConnectionId, previous.twitchUserId, previous.accessToken, previous.refreshToken, previous.tokenExpiry,
    );
    if (!restored) return false;
    await restartTwitchBot();
    return true;
  } catch (restoreErr) {
    log.error('Failed to restore the previous Twitch chat connection after a failed reconnect:', restoreErr);
    return false;
  }
}

/**
 * Handles a `restartTwitchBot()` failure for the newly connected account: logs it, attempts to
 * restore `previous` via {@link tryRestorePreviousConnection}, and redirects with the outcome.
 * Split out of the main handler purely to keep its cyclomatic complexity down — see
 * {@link tryRestorePreviousConnection}'s doc for the restore logic itself.
 * @param res - Express response to redirect.
 * @param newConnectionId - The `connection_id` this callback's own save installed.
 * @param previous - The token active before this callback's save, or null if none was connected yet.
 * @param startErr - The error `restartTwitchBot()` rejected with.
 */
async function redirectAfterFailedRestart(res: Response, newConnectionId: number, previous: BotChatToken | null, startErr: unknown): Promise<void> {
  // The token is saved either way — don't claim a config/exchange failure here, but don't
  // silently report success while chat is actually still offline either. Try to get back to
  // the previous, known-working connection before falling back to a bare warning.
  log.error('Failed to start Twitch chat after connecting:', startErr);
  if (await tryRestorePreviousConnection(newConnectionId, previous)) {
    res.redirect('/admin/bot-auth?error=bot_oauth_connect_failed');
    return;
  }
  res.redirect('/admin/bot-auth?success=bot_connected&warning=chat_start_failed');
}

/**
 * Validates the incoming callback: the OAuth `error`/`code`/`state` query params against the
 * session's `botOAuthState`, and that `TWITCH_BOT_OAUTH_REDIRECT_URI` is configured. Always clears
 * `botOAuthState` from the session first, to prevent replay even on an invalid callback. Split out
 * of the main handler purely to keep its cyclomatic complexity down.
 * @param req - Express request; reads `code`/`state`/`error` query params and the stored
 *   `botOAuthState` session value.
 * @returns An `errorCode` to redirect with if validation failed, otherwise the validated `code`
 *   and this attempt's `attemptStartedAt`.
 */
function validateCallbackRequest(req: Request): { errorCode: string } | { code: string; attemptStartedAt: number } {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const storedOAuth = req.session.botOAuthState;
  delete req.session.botOAuthState;

  if (error) {
    log.warn(`Bot chat OAuth denied: ${error}`);
    return { errorCode: 'bot_oauth_denied' };
  }
  if (!code || !state || !storedOAuth) return { errorCode: 'bot_oauth_state_mismatch' };
  if (!oauthStateMatches(state, storedOAuth.value) || Date.now() > storedOAuth.expiresAt) {
    return { errorCode: 'bot_oauth_state_mismatch' };
  }
  if (!TWITCH_BOT_OAUTH_REDIRECT_URI) {
    log.error('TWITCH_BOT_OAUTH_REDIRECT_URI is not configured');
    return { errorCode: 'bot_oauth_config_failed' };
  }
  return { code, attemptStartedAt: storedOAuth.attemptStartedAt };
}

/**
 * GET /auth/twitch/bot/callback — completes the Twitch OAuth flow started by
 * `/admin/bot-auth/connect` for the bot's own chat account. Validates the OAuth state (via
 * {@link validateCallbackRequest}), exchanges the code for tokens, identifies the connecting
 * Twitch account, and saves the token (see issue #550).
 * @param req - Express request, passed to {@link validateCallbackRequest}.
 * @param res - Express response; redirects to `/admin/bot-auth?success=bot_connected` once the
 *   token is saved and chat has started. If starting chat with the new token fails, either
 *   `?error=bot_oauth_connect_failed` (the previous, still-working connection was restored) or
 *   `?success=bot_connected&warning=chat_start_failed` (no previous connection to restore, or
 *   restoring it also failed — still worth reporting the new account as connected, since the next
 *   successful start, e.g. after a restart, will pick up the saved token). Redirects to
 *   `/admin/bot-auth?error=<code>` if Twitch denied authorization (`error=bot_oauth_denied`), the
 *   OAuth state is missing or mismatched (`error=bot_oauth_state_mismatch`), config is missing or
 *   the token exchange fails (`error=bot_oauth_token_invalid`), a more recently *started* connect
 *   attempt already won the row (`error=bot_oauth_superseded`), or any other error occurs —
 *   including a failure to save the token — (`error=bot_oauth_config_failed`).
 */
router.get('/twitch/bot/callback', async (req, res) => {
  const validated = validateCallbackRequest(req);
  if ('errorCode' in validated) return res.redirect(`/admin/bot-auth?error=${validated.errorCode}`);
  const { code, attemptStartedAt } = validated;

  try {
    const tokens = await exchangeCode(code, TWITCH_BOT_OAUTH_REDIRECT_URI);
    const twitchUser = await getUserFromToken(tokens.access_token);
    if (!twitchUser) return res.redirect('/admin/bot-auth?error=bot_oauth_token_invalid');

    const expiryMs = tokens.expires_in != null ? Date.now() + tokens.expires_in * 1000 - 60_000 : null;
    // Captured before overwriting the row, so a failed restart below has something to restore.
    const previous = await getBotChatToken();

    // Save first, before touching the running chat client — if this throws, the catch below
    // reports a config-failed error and an already-working bot (on the old token) is never
    // stopped over a save that never happened. Ordered against any other in-flight connect
    // attempt by attemptStartedAt (see saveBotChatTokenIfLatestAttempt's doc) rather than by
    // whichever callback's network round trip happens to finish first.
    const newConnectionId = await saveBotChatTokenIfLatestAttempt(
      attemptStartedAt, twitchUser.id, tokens.access_token, tokens.refresh_token, expiryMs,
    );
    if (newConnectionId === null) {
      log.warn(`Bot chat OAuth callback for ${twitchUser.login} superseded by a more recently started connect attempt — ignoring.`);
      return res.redirect('/admin/bot-auth?error=bot_oauth_superseded');
    }
    log.info(`Bot chat OAuth connected as ${twitchUser.login}`);

    // Only now stop any already-running chat client — its RefreshingAuthProvider's onRefresh
    // handler could otherwise still write a refreshed *old* token back over the row just saved.
    // restartTwitchBot() is a no-op stop if the bot never started (e.g. this is the very first
    // connect), so this covers both the initial-connect and reconnect cases. It also serializes
    // against a second, overlapping callback (e.g. the owner double-submitting or using two
    // tabs) so both can't stop the bot before either has (re)started it.
    try {
      await restartTwitchBot();
      res.redirect('/admin/bot-auth?success=bot_connected');
    } catch (startErr) {
      await redirectAfterFailedRestart(res, newConnectionId, previous, startErr);
    }
  } catch (err) {
    logAndRedirectError({
      res, log, logLabel: 'Bot chat OAuth callback error:', err, basePath: '/admin/bot-auth', errorCode: 'bot_oauth_config_failed',
    });
  }
});

export default router;
