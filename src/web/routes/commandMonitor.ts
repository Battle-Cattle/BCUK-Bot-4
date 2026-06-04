import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getRecentCommandTestEntries } from '../../commands/commandMonitorStore';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';
import { renderError } from './shared';

const log = createLogger('Web');
const router = Router();

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

router.get('/command-monitor/recent', requireManager, (_req, res) => {
  try {
    res.json({ entries: getRecentCommandTestEntries() });
  } catch (err) {
    log.error('Command monitor recent entries error:', err);
    res.status(500).json({ entries: [] });
  }
});

export default router;
