import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { requireOwner } from '../middleware';
import { csrfProtection } from '../csrf';
import { getHealthSnapshot } from '../../shared/healthStore';
import { renderView, renderError } from './viewHelpers';

const log = createLogger('Web');
const router = Router();

/**
 * GET /admin/health — renders the owner-only bot health dashboard, summarizing
 * `healthStore.getHealthSnapshot()` (Discord/Twitch chat connection state, DB
 * ping, per-streamer EventSub status, stream-monitor poll status, scheduler
 * runs, and recent errors). Not guild-scoped — health isn't per-guild.
 * @param req - Express request; reads `req.session.user`.
 * @param res - Express response; renders the `health` view, or a 500 error
 *   page if building the response somehow throws.
 */
router.get('/', requireOwner, csrfProtection, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    renderView(res, 'health', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      health: getHealthSnapshot(),
    });
  } catch (err) {
    log.error('Failed to render health dashboard:', err);
    renderError(res, 500, 'Failed to load health dashboard.', req.session.user);
  }
});

export default router;
