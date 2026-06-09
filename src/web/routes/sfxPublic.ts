import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getPublicSfxTriggers } from '../../db';
import type { PublicSfxTrigger } from '../../db';
import { renderError } from './shared';

const log = createLogger('Web');
const router = Router();

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { data: PublicSfxTrigger[]; expiresAt: number } | null = null;
let inFlight: Promise<PublicSfxTrigger[]> | null = null;

async function getCachedData(): Promise<PublicSfxTrigger[]> {
  if (cache && Date.now() < cache.expiresAt) return cache.data;
  if (inFlight) return inFlight;
  inFlight = getPublicSfxTriggers()
    .then((data) => {
      cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
      return data;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
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
    renderError(res, 500, 'Failed to load SFX list.', req.session.user);
  }
});

export default router;
