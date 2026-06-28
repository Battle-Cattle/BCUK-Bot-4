import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { clearStreamerToken } from '../../db';
import { csrfProtection } from '../csrf';
import { requireAdmin } from '../middleware';
import { reloadEventSubSubscriptions } from '../../twitch/eventsub/twitchEventSub';
import { parsePositiveIntId } from './shared';

const log = createLogger('Web');
const router = Router();

// Admin-only emergency disconnect — e.g. if a streamer's OAuth token is compromised.
// Normal connect/disconnect flows live in /user/settings.

/**
 * POST /admin/streams/twitch-disconnect/:streamerId — admin-only forced disconnect of
 * a streamer's Twitch OAuth token, e.g. if it has been compromised. Clears the stored
 * token and reloads EventSub subscriptions.
 * @param req - Express request; reads the `streamerId` route param.
 * @param res - Express response; redirects to `/admin/streams` on success, or to
 *   `/admin/streams?error=<code>` if `streamerId` is not a valid positive integer
 *   (`error=invalid_id`) or the disconnect fails (`error=eventsub_disconnect_failed`).
 */
router.post('/streams/twitch-disconnect/:streamerId', requireAdmin, csrfProtection, async (req, res) => {
  const streamerId = parsePositiveIntId(req.params.streamerId);
  if (streamerId === null) return res.redirect('/admin/streams?error=invalid_id');

  try {
    await clearStreamerToken(streamerId);
    reloadEventSubSubscriptions();
  } catch (err) {
    log.error('EventSub admin disconnect error:', err);
    return res.redirect('/admin/streams?error=eventsub_disconnect_failed');
  }
  res.redirect('/admin/streams');
});

export default router;
