import { createLogger } from '../../logger';
import { Router } from 'express';
import { getStatus } from '../../statusStore';
import { csrfProtection } from '../csrf';

const log = createLogger('Web');
const router = Router();

router.get('/', csrfProtection, async (req, res) => {
  try {
    const status = getStatus();
    res.render('dashboard', {
      user: req.session.user,
      status,
      csrfToken: req.csrfToken(),
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
