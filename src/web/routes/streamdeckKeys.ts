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
import { WEB_PORT } from '../../config';

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
      webPort: WEB_PORT,
    });
  } catch (err) {
    console.error('[Web] Streamdeck key page error:', err);
    res.status(500).render('error', {
      message: 'Failed to load Streamdeck key status.',
      user: req.session.user ?? null,
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
      webPort: WEB_PORT,
    });
  } catch (err) {
    console.error('[Web] Streamdeck key request error:', err);
    res.status(500).render('error', {
      message: 'Failed to generate API key.',
      user: req.session.user ?? null,
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
    });
  }
});

// ─── Admin routes ─────────────────────────────────────────────────────────────

const ADMIN_KNOWN_ERRORS = new Set(['approve_failed', 'deny_failed', 'revoke_failed', 'invalid_discord_id']);

const DISCORD_ID_RE = /^\d{17,20}$/;

function validateDiscordId(discordId: string | undefined): string | null {
  const trimmed = discordId?.trim();
  if (!trimmed || !DISCORD_ID_RE.test(trimmed)) return null;
  return trimmed;
}

router.get('/admin/streamdeck-keys', requireAdmin, csrfProtection, async (req, res) => {
  try {
    const [pending, all] = await Promise.all([getPendingRequests(), getAllApiKeys()]);
    res.render('streamdeck-keys-admin', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      pending,
      all,
      error: ADMIN_KNOWN_ERRORS.has(req.query.error as string) ? (req.query.error as string) : null,
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
  const validId = validateDiscordId((req.body as { discord_id?: string }).discord_id);
  if (!validId) return res.redirect('/admin/streamdeck-keys?error=invalid_discord_id');
  try {
    await approveApiKey(validId, req.session.user!.discordId);
    res.redirect('/admin/streamdeck-keys');
  } catch (err) {
    console.error('[Web] Streamdeck key approve error:', err);
    res.redirect('/admin/streamdeck-keys?error=approve_failed');
  }
});

router.post('/admin/streamdeck-keys/deny', requireAdmin, csrfProtection, async (req, res) => {
  const validId = validateDiscordId((req.body as { discord_id?: string }).discord_id);
  if (!validId) return res.redirect('/admin/streamdeck-keys?error=invalid_discord_id');
  try {
    await denyApiKey(validId);
    res.redirect('/admin/streamdeck-keys');
  } catch (err) {
    console.error('[Web] Streamdeck key deny error:', err);
    res.redirect('/admin/streamdeck-keys?error=deny_failed');
  }
});

router.post('/admin/streamdeck-keys/revoke', requireAdmin, csrfProtection, async (req, res) => {
  const validId = validateDiscordId((req.body as { discord_id?: string }).discord_id);
  if (!validId) return res.redirect('/admin/streamdeck-keys?error=invalid_discord_id');
  try {
    await revokeApiKey(validId);
    res.redirect('/admin/streamdeck-keys');
  } catch (err) {
    console.error('[Web] Streamdeck key admin revoke error:', err);
    res.redirect('/admin/streamdeck-keys?error=revoke_failed');
  }
});

export default router;
