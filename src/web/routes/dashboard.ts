import { createLogger } from '../../logger';
import { Router } from 'express';
import { getStatus } from '../../statusStore';
import { csrfProtection } from '../csrf';
import { getStreamerByDiscordId } from '../../db';
import { hasAuthFailedSubs } from '../../twitchEventSubSubscriptions';

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
    res.status(500).render('error', {
      message: 'Failed to load dashboard data.',
      user: req.session.user ?? null,
    });
  }
});

export default router;
