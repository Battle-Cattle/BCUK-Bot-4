import { createLogger } from '../../logger';
import { Router } from 'express';
import { getPublicSfxTriggers } from '../../db';
import type { PublicSfxTrigger } from '../../db';

const log = createLogger('Web');
const router = Router();

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { data: PublicSfxTrigger[]; expiresAt: number } | null = null;

async function getCachedData(): Promise<PublicSfxTrigger[]> {
  if (cache && Date.now() < cache.expiresAt) return cache.data;
  const data = await getPublicSfxTriggers();
  cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

router.get('/sfx-list', async (req, res) => {
  try {
    const triggers = await getCachedData();
    res.render('sfx-public', {
      user: req.session.user ?? null,
      triggers,
    });
  } catch (err) {
    log.error('Public SFX list error:', err);
    res.status(500).render('error', {
      message: 'Failed to load SFX list.',
      user: req.session.user ?? null,
      csrfToken: '',
    });
  }
});

export default router;
