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

const router = Router();

// ─── User routes (any authenticated user) ────────────────────────────────────

router.get('/streamdeck-key', csrfProtection, async (req, res) => {
  try {
    const keyRow = await getApiKeyStatus(req.session.user!.discordId);
    res.render('streamdeck-keys', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      keyRow,
      newKey: null,
      error: null,
    });
  } catch (err) {
    console.error('[Web] Streamdeck key page error:', err);
    res.status(500).render('error', {
      message: 'Failed to load Streamdeck key status.',
      user: req.session.user ?? null,
      csrfToken: '',
    });
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
    });
  } catch (err) {
    console.error('[Web] Streamdeck key request error:', err);
    res.status(500).render('error', {
      message: 'Failed to generate API key.',
      user: req.session.user ?? null,
      csrfToken: '',
    });
  }
});

router.post('/streamdeck-key/revoke', csrfProtection, async (req, res) => {
  try {
    await revokeApiKey(req.session.user!.discordId);
    res.redirect('/streamdeck-key');
  } catch (err) {
    console.error('[Web] Streamdeck key revoke error:', err);
    res.status(500).render('error', {
      message: 'Failed to revoke API key.',
      user: req.session.user ?? null,
      csrfToken: '',
    });
  }
});

// ─── Admin routes ─────────────────────────────────────────────────────────────

router.get('/admin/streamdeck-keys', requireAdmin, csrfProtection, async (req, res) => {
  try {
    const [pending, all] = await Promise.all([getPendingRequests(), getAllApiKeys()]);
    res.render('streamdeck-keys-admin', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      pending,
      all,
      error: null,
    });
  } catch (err) {
    console.error('[Web] Streamdeck admin keys error:', err);
    res.status(500).render('error', {
      message: 'Failed to load Streamdeck key management.',
      user: req.session.user ?? null,
      csrfToken: '',
    });
  }
});

router.post('/admin/streamdeck-keys/approve', requireAdmin, csrfProtection, async (req, res) => {
  const { discord_id } = req.body as { discord_id?: string };
  if (!discord_id?.trim()) return res.redirect('/admin/streamdeck-keys');
  try {
    await approveApiKey(discord_id.trim(), req.session.user!.discordId);
    res.redirect('/admin/streamdeck-keys');
  } catch (err) {
    console.error('[Web] Streamdeck key approve error:', err);
    res.redirect('/admin/streamdeck-keys?error=approve_failed');
  }
});

router.post('/admin/streamdeck-keys/deny', requireAdmin, csrfProtection, async (req, res) => {
  const { discord_id } = req.body as { discord_id?: string };
  if (!discord_id?.trim()) return res.redirect('/admin/streamdeck-keys');
  try {
    await denyApiKey(discord_id.trim());
    res.redirect('/admin/streamdeck-keys');
  } catch (err) {
    console.error('[Web] Streamdeck key deny error:', err);
    res.redirect('/admin/streamdeck-keys?error=deny_failed');
  }
});

router.post('/admin/streamdeck-keys/revoke', requireAdmin, csrfProtection, async (req, res) => {
  const { discord_id } = req.body as { discord_id?: string };
  if (!discord_id?.trim()) return res.redirect('/admin/streamdeck-keys');
  try {
    await revokeApiKey(discord_id.trim());
    res.redirect('/admin/streamdeck-keys');
  } catch (err) {
    console.error('[Web] Streamdeck key admin revoke error:', err);
    res.redirect('/admin/streamdeck-keys?error=revoke_failed');
  }
});

export default router;
