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
