import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { getStreamerByDiscordId } from '../../db';
import { PUBLIC_URL } from '../../shared/config';
import { renderView, renderError } from './shared';

const log = createLogger('TriviaAdmin');
const router = Router();

/**
 * GET /trivia/settings — renders the trivia overlay settings page with the logged-in user's own
 * OBS browser source URL (solo play) and, if they currently have a Discord guild selected, the
 * same URL tagged with `?guild=` for a synchronized round with the rest of that guild's streamers.
 * @param req - Express request; reads `req.session.user` (including `currentGuildId`).
 * @param res - Express response; renders the `triviaAdmin` view, or a 500 error page if loading
 *   the user's streamer record fails.
 */
router.get('/settings', requireAuth, async (req, res) => {
  try {
    const streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);

    renderView(res, 'triviaAdmin', {
      user: req.session.user,
      streamer: streamer ?? null,
      baseUrl: PUBLIC_URL,
      guildId: getSessionUser(req).currentGuildId ?? null,
    });
  } catch (err) {
    log.error('Trivia settings page error:', err);
    renderError(res, 500, 'Failed to load trivia settings.', req.session.user);
  }
});

export default router;
