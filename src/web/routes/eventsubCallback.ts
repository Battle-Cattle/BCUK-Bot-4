import { createLogger } from '../../logger';
import { Router } from 'express';
import { getAllEventSubStreamers, saveStreamerToken } from '../../db';
import { exchangeCode, getUserFromToken } from '../../twitchApi';
import { TWITCH_EVENTSUB_REDIRECT_URI } from '../../config';
import { reloadEventSubSubscriptions } from '../../twitchEventSub';

const log = createLogger('Web');
const router = Router();

// GET /auth/twitch/eventsub/callback
// No requireAuth — Twitch redirects here outside the normal admin session flow.
// CSRF is handled via the session state set during OAuth initiation.
router.get('/twitch/eventsub/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;

  if (error) {
    log.warn(`EventSub OAuth denied: ${error}`);
    return res.redirect('/admin/streams?error=eventsub_oauth_denied');
  }

  const expectedState = req.session.eventsubOAuthState;
  const streamerId = req.session.eventsubStreamerId;

  // Clear state from session immediately to prevent replay
  delete req.session.eventsubOAuthState;
  delete req.session.eventsubStreamerId;

  if (!code || !state || !expectedState || !streamerId) {
    return res.redirect('/admin/streams?error=eventsub_oauth_state_mismatch');
  }
  if (state !== expectedState) {
    return res.redirect('/admin/streams?error=eventsub_oauth_state_mismatch');
  }

  if (!TWITCH_EVENTSUB_REDIRECT_URI) {
    log.error('TWITCH_EVENTSUB_REDIRECT_URI is not configured');
    return res.redirect('/admin/streams?error=eventsub_config_failed');
  }

  try {
    const tokens = await exchangeCode(code, TWITCH_EVENTSUB_REDIRECT_URI);
    const user = await getUserFromToken(tokens.access_token);
    if (!user) return res.redirect('/admin/streams?error=eventsub_token_invalid');

    const streamers = await getAllEventSubStreamers();
    const streamer = streamers.find((s) => s.id === streamerId);
    if (!streamer) return res.redirect('/admin/streams?error=invalid_id');

    if (user.login.toLowerCase() !== streamer.name.toLowerCase()) {
      log.warn(`EventSub OAuth mismatch: expected ${streamer.name}, got ${user.login}`);
      return res.redirect(`/admin/streams?error=eventsub_wrong_account&expected=${encodeURIComponent(streamer.name)}`);
    }

    const expiryMs = Date.now() + tokens.expires_in * 1000 - 60_000;
    await saveStreamerToken(streamerId, user.id, tokens.access_token, tokens.refresh_token, expiryMs);
    reloadEventSubSubscriptions();
    log.info(`EventSub OAuth connected for ${streamer.name}`);
    res.redirect('/admin/streams?success=twitch_connected');
  } catch (err) {
    log.error('EventSub OAuth callback error:', err);
    res.redirect('/admin/streams?error=eventsub_config_failed');
  }
});

export default router;
