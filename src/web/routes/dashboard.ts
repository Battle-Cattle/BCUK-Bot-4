import { Router } from 'express';
import { getAllSfxTriggers } from '../../db';
import { getStatus } from '../../statusStore';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const [triggers, status] = await Promise.all([getAllSfxTriggers(), getStatus()]);
    res.render('dashboard', { user: req.session.user, triggers, status });
  } catch (err) {
    console.error('[Web] Dashboard error:', err);
    res.status(500).render('error', {
      message: 'Failed to load dashboard data.',
      user: req.session.user ?? null,
    });
  }
});

export default router;
