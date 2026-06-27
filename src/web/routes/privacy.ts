import { Router } from 'express';
import { ensureSessionCsrfToken } from '../csrf';

const router = Router();

/** Renders the public privacy/cookie notice page. Accessible whether or not the user is signed in. */
router.get('/privacy', (req, res) => {
  res.render('privacy', {
    user: req.session.user ?? null,
    csrfToken: req.session.user ? ensureSessionCsrfToken(req) : '',
  });
});

export default router;
