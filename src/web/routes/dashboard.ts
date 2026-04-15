import { Router } from 'express';
import { getAllSfxTriggers } from '../../db';
import { getStatus } from '../../statusStore';
import { csrfProtection } from '../csrf';

const router = Router();

router.get('/', csrfProtection, async (req, res) => {
  try {
    const triggers = await getAllSfxTriggers();
    const status = getStatus();
    res.render('dashboard', {
      user: req.session.user,
      triggers,
      status,
      csrfToken: req.csrfToken(),
    });
  } catch (err) {
    console.error('[Web] Dashboard error:', err);
    res.status(500).render('error', {
      message: 'Failed to load dashboard data.',
      user: req.session.user ?? null,
    });
  }
});

export default router;
