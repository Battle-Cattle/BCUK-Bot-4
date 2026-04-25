import { Router } from 'express';
import { getStatus } from '../../statusStore';
import { requireMod } from '../middleware';
import { connect, disconnect } from '../../audioPlayer';
import { discordClient } from '../../discordBot';
import { csrfProtection } from '../csrf';

const router = Router();

// Live status JSON — polled by the dashboard frontend every few seconds
router.get('/status', (_req, res) => {
  res.json(getStatus());
});

// Rejoin the configured voice channel — Mod and above
router.post('/voice/join', requireMod, csrfProtection, async (_req, res) => {
  if (!discordClient) {
    res.status(503).json({ ok: false, error: 'Discord client not ready' });
    return;
  }
  try {
    disconnect();
    await connect(discordClient);
    res.json({ ok: true });
  } catch (err) {
    console.error('[API] Voice rejoin failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to join voice channel' });
  }
});

// Leave the voice channel — Mod and above
router.post('/voice/leave', requireMod, csrfProtection, (_req, res) => {
  disconnect();
  res.json({ ok: true });
});

export default router;
