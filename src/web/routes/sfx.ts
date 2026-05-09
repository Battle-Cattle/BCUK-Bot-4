import { Router } from 'express';
import { getAllSfxTriggers } from '../../db';
import { csrfProtection } from '../csrf';

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
    console.error('[Web] SFX error:', err);
    res.status(500).render('error', {
      message: 'Failed to load SFX data.',
      user: req.session.user ?? null,
    });
  }
});

export default router;
