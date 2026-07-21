import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { clearStreamerToken } from '../../db';
import { csrfProtection } from '../csrf';
import { requireAdmin } from '../middleware';
import { getSessionUser } from '../session';
import { reloadEventSubSubscriptions } from '../../twitch/eventsub/twitchEventSub';
import { parsePositiveIntId } from './shared';
import { redirectStreamsInvalid, redirectStreamsFailure } from './streamsErrors';

const log = createLogger('Web');
const router = Router();

// Admin-only emergency disconnect — e.g. if a streamer's OAuth token is compromised.
// Normal connect/disconnect flows live in /user/settings.

/**
 * POST /admin/streams/twitch-disconnect/:streamerId — admin-only forced disconnect of
 * a streamer's Twitch OAuth token, e.g. if it has been compromised. Clears the stored
 * token, scoped to the admin's currently-selected guild so an admin cannot force-disconnect
 * a streamer belonging to a different guild, and reloads EventSub subscriptions.
 * @param req - Express request; reads the `streamerId` route param and the caller's
 *   `currentGuildId` from the session.
 * @param res - Express response; redirects to `/admin/streams` on success, or to
 *   `/admin/streams?error=<code>` if `streamerId` is not a valid positive integer or
 *   doesn't belong to the caller's current guild (`error=invalid_id`), or the disconnect
 *   fails (`error=eventsub_disconnect_failed`).
 */
router.post('/streams/twitch-disconnect/:streamerId', requireAdmin, csrfProtection, async (req, res) => {
  const streamerId = parsePositiveIntId(req.params.streamerId);
  if (streamerId === null) return redirectStreamsInvalid(res, 'invalid_id');

  try {
    const cleared = await clearStreamerToken(streamerId, getSessionUser(req).currentGuildId!);
    if (!cleared) return redirectStreamsInvalid(res, 'invalid_id');
    reloadEventSubSubscriptions();
  } catch (err) {
    return redirectStreamsFailure(res, log, 'EventSub admin disconnect error:', err, 'eventsub_disconnect_failed');
  }
  res.redirect('/admin/streams');
});

export default router;
