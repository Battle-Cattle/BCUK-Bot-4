import { Router } from 'express';
import { ensureSessionCsrfToken } from '../csrf';

const router = Router();

/** Renders the public Terms of Service page. Accessible whether or not the user is signed in. */
router.get('/tos', (req, res) => {
  res.render('tos', {
    user: req.session.user ?? null,
    csrfToken: req.session.user ? ensureSessionCsrfToken(req) : '',
  });
});

export default router;
