import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { issueToken, getTokenStatus, revokeToken } from '../../db';
import { csrfProtection } from '../csrf';
import { renderError, filterQueryParam } from './shared';

const log = createLogger('Web');
const router = Router();

const KNOWN_ERRORS = new Set(['request_failed', 'revoke_failed']);

/** Renders the current user's companion app token status page. */
router.get('/companion-key', csrfProtection, async (req, res) => {
  try {
    const tokenStatus = await getTokenStatus(req.session.user!.discordId);
    res.render('companion-keys', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      tokenStatus,
      newToken: null,
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
    });
  } catch (err) {
    log.error('Companion key page error:', err);
    renderError(res, 500, 'Failed to load companion app token status.', req.session.user);
  }
});

/** Issues (or replaces) a companion app token for the current user — manual fallback to the OAuth login flow. */
router.post('/companion-key/request', csrfProtection, async (req, res) => {
  try {
    const plain = await issueToken(req.session.user!.discordId);
    const tokenStatus = await getTokenStatus(req.session.user!.discordId);
    res.render('companion-keys', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      tokenStatus,
      newToken: plain,
      error: null,
    });
  } catch (err) {
    log.error('Companion key request error:', err);
    res.redirect('/companion-key?error=request_failed');
  }
});

/** Revokes the current user's companion app token. */
router.post('/companion-key/revoke', csrfProtection, async (req, res) => {
  try {
    await revokeToken(req.session.user!.discordId);
    res.redirect('/companion-key');
  } catch (err) {
    log.error('Companion key revoke error:', err);
    res.redirect('/companion-key?error=revoke_failed');
  }
});

export default router;
