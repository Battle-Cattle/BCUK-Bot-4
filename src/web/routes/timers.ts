import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { getStreamerByDiscordId, getTimerCommandsForStreamer } from '../../db';
import type { DbTimerCommand } from '../../db';
import { renderError, renderView, filterQueryParam } from './shared';
import timersMutationsRouter from './timersMutations';

const log = createLogger('Timers');
const router = Router();

const KNOWN_ERRORS = new Set([
  'not_a_streamer', 'missing_fields', 'invalid_interval', 'invalid_min_messages',
  'invalid_id', 'timer_not_found', 'add_failed', 'update_failed', 'remove_failed', 'toggle_failed',
]);
const KNOWN_SUCCESSES = new Set(['timer_added', 'timer_updated', 'timer_removed']);

/**
 * GET /timers — renders the self-service timer-commands page for the logged-in streamer:
 * their own timers (name, message, interval, min-messages, live requirement, enabled state)
 * plus an add form. Shows a "link your Twitch account" prompt instead of the timer list when
 * the session user has no linked `streamer` record, mirroring `/channel-points`'s handling of
 * the same case — no redirect loop, since a non-streamer viewing this page isn't an error.
 * @param req - Express request; reads `req.session.user`, `error`, and `success` query params.
 * @param res - Express response; renders the `timers` view, or a 500 error page on failure.
 */
router.get('/', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
    const timers: DbTimerCommand[] = streamer ? await getTimerCommandsForStreamer(streamer.id) : [];

    renderView(res, 'timers', {
      user: req.session.user,
      isStreamer: !!streamer,
      timers,
      csrfToken: req.csrfToken(),
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
      success: filterQueryParam(req.query.success, KNOWN_SUCCESSES),
    });
  } catch (err) {
    log.error('Timers page error:', err);
    renderError(res, 500, 'Failed to load timers page.', req.session.user);
  }
});

router.use(timersMutationsRouter);

export default router;
