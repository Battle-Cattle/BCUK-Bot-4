import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  requestApiKey,
  getApiKeyStatus,
  revokeApiKey,
  approveApiKey,
  denyApiKey,
  getAllApiKeys,
  getPendingRequests,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireAdmin } from '../middleware';
import { WEB_PORT } from '../../shared/config';
import { normalizeDiscordId, renderError, filterQueryParam } from './shared';

const log = createLogger('Web');
const router = Router();

// ─── User routes (any authenticated user) ────────────────────────────────────

const USER_KNOWN_ERRORS = new Set(['request_failed', 'revoke_failed']);

router.get('/streamdeck-key', csrfProtection, async (req, res) => {
  try {
    const keyRow = await getApiKeyStatus(req.session.user!.discordId);
    res.render('streamdeck-keys', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      keyRow,
      newKey: null,
      error: filterQueryParam(req.query.error, USER_KNOWN_ERRORS),
      webPort: WEB_PORT,
    });
  } catch (err) {
    log.error('Streamdeck key page error:', err);
    renderError(res, 500, 'Failed to load Streamdeck key status.', req.session.user);
  }
});

router.post('/streamdeck-key/request', csrfProtection, async (req, res) => {
  try {
    const { plain } = await requestApiKey(
      req.session.user!.discordId,
      req.session.user!.accessLevel,
    );
    const keyRow = await getApiKeyStatus(req.session.user!.discordId);
    res.render('streamdeck-keys', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      keyRow,
      newKey: plain,
      error: null,
      webPort: WEB_PORT,
    });
  } catch (err) {
    log.error('Streamdeck key request error:', err);
    res.redirect('/streamdeck-key?error=request_failed');
  }
});

router.post('/streamdeck-key/revoke', csrfProtection, async (req, res) => {
  try {
    await revokeApiKey(req.session.user!.discordId);
    res.redirect('/streamdeck-key');
  } catch (err) {
    log.error('Streamdeck key revoke error:', err);
    res.redirect('/streamdeck-key?error=revoke_failed');
  }
});

// ─── Admin routes ─────────────────────────────────────────────────────────────

const ADMIN_KNOWN_ERRORS = new Set(['approve_failed', 'deny_failed', 'revoke_failed', 'invalid_discord_id']);

router.get('/admin/streamdeck-keys', requireAdmin, csrfProtection, async (req, res) => {
  try {
    const [pending, all] = await Promise.all([getPendingRequests(), getAllApiKeys()]);
    res.render('streamdeck-keys-admin', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      pending,
      all,
      error: filterQueryParam(req.query.error, ADMIN_KNOWN_ERRORS),
    });
  } catch (err) {
    log.error('Streamdeck admin keys error:', err);
    renderError(res, 500, 'Failed to load Streamdeck key management.', req.session.user);
  }
});

router.post('/admin/streamdeck-keys/approve', requireAdmin, csrfProtection, async (req, res) => {
  const validId = normalizeDiscordId((req.body as { discord_id?: string }).discord_id);
  if (!validId) return res.redirect('/admin/streamdeck-keys?error=invalid_discord_id');
  try {
    await approveApiKey(validId, req.session.user!.discordId);
    res.redirect('/admin/streamdeck-keys');
  } catch (err) {
    log.error('Streamdeck key approve error:', err);
    res.redirect('/admin/streamdeck-keys?error=approve_failed');
  }
});

router.post('/admin/streamdeck-keys/deny', requireAdmin, csrfProtection, async (req, res) => {
  const validId = normalizeDiscordId((req.body as { discord_id?: string }).discord_id);
  if (!validId) return res.redirect('/admin/streamdeck-keys?error=invalid_discord_id');
  try {
    await denyApiKey(validId);
    res.redirect('/admin/streamdeck-keys');
  } catch (err) {
    log.error('Streamdeck key deny error:', err);
    res.redirect('/admin/streamdeck-keys?error=deny_failed');
  }
});

router.post('/admin/streamdeck-keys/revoke', requireAdmin, csrfProtection, async (req, res) => {
  const validId = normalizeDiscordId((req.body as { discord_id?: string }).discord_id);
  if (!validId) return res.redirect('/admin/streamdeck-keys?error=invalid_discord_id');
  try {
    await revokeApiKey(validId);
    res.redirect('/admin/streamdeck-keys');
  } catch (err) {
    log.error('Streamdeck key admin revoke error:', err);
    res.redirect('/admin/streamdeck-keys?error=revoke_failed');
  }
});

export default router;
