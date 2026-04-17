import { Router } from 'express';
import { getRecentCommandTestEntries } from '../../commandTestingStore';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';

const router = Router();

router.get('/testing', requireManager, csrfProtection, (req, res) => {
  try {
    const recentEntries = getRecentCommandTestEntries();
    res.render('testing', {
      user: req.session.user,
      recentEntries,
      csrfToken: req.csrfToken(),
    });
  } catch (err) {
    console.error('[Web] Testing page error:', err);
    res.status(500).render('error', {
      message: 'Failed to load command testing page.',
      user: req.session.user ?? null,
    });
  }
});

router.get('/testing/recent', requireManager, (_req, res) => {
  res.json({ entries: getRecentCommandTestEntries() });
});

export default router;
