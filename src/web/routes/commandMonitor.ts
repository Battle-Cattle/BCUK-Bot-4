import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getRecentCommandTestEntries } from '../../commands/commandMonitorStore';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';
import { renderError } from './shared';

const log = createLogger('Web');
const router = Router();

/**
 * GET /command-monitor — renders the command monitor page showing recently
 * triggered command test entries.
 * @param req - Express request; reads `req.session.user`.
 * @param res - Express response; renders the `command-monitor` view, or a 500
 *   error page if loading recent entries fails.
 */
router.get('/command-monitor', requireManager, csrfProtection, (req, res) => {
  try {
    const recentEntries = getRecentCommandTestEntries();
    res.render('command-monitor', {
      user: req.session.user,
      recentEntries,
      csrfToken: req.csrfToken(),
    });
  } catch (err) {
    log.error('Command monitor page error:', err);
    renderError(res, 500, 'Failed to load command monitor page.', req.session.user);
  }
});

/**
 * GET /command-monitor/recent — polling endpoint returning recent command test
 * entries as JSON, for live-refreshing the command monitor page.
 * @param _req - Express request (unused).
 * @param res - Express response; responds 200 with `{ entries }` on success, or
 *   500 with `{ entries: [] }` if fetching entries fails.
 */
router.get('/command-monitor/recent', requireManager, (_req, res) => {
  try {
    res.json({ entries: getRecentCommandTestEntries() });
  } catch (err) {
    log.error('Command monitor recent entries error:', err);
    res.status(500).json({ entries: [] });
  }
});

export default router;
