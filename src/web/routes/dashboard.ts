import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getStatus } from '../../shared/statusStore';
import { csrfProtection } from '../csrf';
import { getStreamerByDiscordId } from '../../db';
import { hasAuthFailedSubs } from '../../twitch/eventsub/twitchEventSubSubscriptions';
import { renderError } from './shared';

const log = createLogger('Web');
const router = Router();

router.get('/', csrfProtection, async (req, res) => {
  try {
    const status = getStatus();
    let needsReconnect = false;
    if (req.session.user) {
      const streamer = await getStreamerByDiscordId(req.session.user.discordId);
      needsReconnect = !!(streamer?.eventsub_access_token && streamer.twitch_name && hasAuthFailedSubs(streamer.twitch_name));
    }
    res.render('dashboard', {
      user: req.session.user,
      status,
      csrfToken: req.csrfToken(),
      needsReconnect,
    });
  } catch (err) {
    log.error('Dashboard error:', err);
    renderError(res, 500, 'Failed to load dashboard data.', req.session.user);
  }
});

export default router;
