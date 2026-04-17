import { Router } from 'express';
import { getRecentCommandTestEntries } from '../../commandMonitorStore';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';

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
    console.error('[Web] Command monitor page error:', err);
    res.status(500).render('error', {
      message: 'Failed to load command monitor page.',
      user: req.session.user ?? null,
    });
  }
});

router.get('/command-monitor/recent', requireManager, (_req, res) => {
  res.json({ entries: getRecentCommandTestEntries() });
});

export default router;
