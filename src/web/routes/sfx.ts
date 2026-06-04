import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getAllSfxTriggers } from '../../db';
import { csrfProtection } from '../csrf';
import { renderError } from './shared';

const log = createLogger('Web');
const router = Router();

router.get('/sfx', csrfProtection, async (req, res) => {
  try {
    const triggers = await getAllSfxTriggers();
    res.render('sfx', {
      user: req.session.user,
      triggers,
      csrfToken: req.csrfToken(),
    });
  } catch (err) {
    log.error('SFX error:', err);
    renderError(res, 500, 'Failed to load SFX data.', req.session.user);
  }
});

export default router;
