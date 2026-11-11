// Stream Deck API for the shared video overlay (#917): list the enabled shared videos, and play
// one on every connected shared overlay at once. Any approved API key may trigger; the shared
// list belongs to no single streamer, so nothing here resolves a streamer.
import { createLogger } from '../../shared/logger';
import { SHARED_OVERLAY_LEAD_MS, SHARED_OVERLAY_TRIGGER_COOLDOWN_MS } from '../../shared/config';
import { Router, type Request } from 'express';
import { getSharedVideo, listEnabledSharedVideos } from '../../db';
import { requireApiKey } from '../middleware';
import { pushSharedPlay, sharedVideoUrl } from './sharedOverlaySource';

const log = createLogger('StreamdeckSharedVideos');
const router = Router();

/** Time of the last accepted trigger, for the global cooldown (single process, so in memory). */
let lastTriggerAt = 0;

/**
 * Reads a positive integer `videoId` from the JSON body.
 * @param req - The request.
 * @returns The id, or null if missing or invalid.
 */
function parseVideoId(req: Request): number | null {
  const { videoId } = (req.body ?? {}) as { videoId?: unknown };
  const id = typeof videoId === 'string' ? Number(videoId) : videoId;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * GET /api/streamdeck/shared-videos — lists the enabled shared videos for the plugin's dropdown.
 * @param _req - Express request; authenticated by `requireApiKey`.
 * @param res - `{ ok, videos: [{ id, name }] }`, or 500 on a DB error.
 */
router.get('/shared-videos', requireApiKey, async (_req, res) => {
  try {
    const videos = (await listEnabledSharedVideos()).map((v) => ({ id: v.id, name: v.name }));
    res.json({ ok: true, videos });
  } catch (err) {
    log.error('Failed to list shared videos:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch videos' });
  }
});

/**
 * POST /api/streamdeck/shared-videos/trigger — plays a shared video on every connected shared
 * overlay, starting after the configured lead time. A trigger inside the global cooldown of the
 * last accepted one is answered with `triggered: false` and nothing is sent.
 * @param req - Express request; JSON body `{ videoId }`.
 * @param res - `{ ok: true, triggered: true, reached }`, `{ ok: true, triggered: false, reason:
 *   'cooldown' }`, 400 for a bad id, 404 `video_not_found` (unknown or disabled), or 500.
 */
router.post('/shared-videos/trigger', requireApiKey, async (req, res) => {
  const videoId = parseVideoId(req);
  if (videoId === null) {
    res.status(400).json({ ok: false, error: 'Missing or invalid "videoId" field' });
    return;
  }
  try {
    const video = await getSharedVideo(videoId);
    if (!video?.enabled) {
      res.status(404).json({ ok: false, error: 'video_not_found' });
      return;
    }
    const now = Date.now();
    // Checked after the awaited lookup and set before any other await, so two presses at once
    // can't both pass.
    if (now - lastTriggerAt < SHARED_OVERLAY_TRIGGER_COOLDOWN_MS) {
      res.json({ ok: true, triggered: false, reason: 'cooldown' });
      return;
    }
    lastTriggerAt = now;
    const reached = pushSharedPlay(sharedVideoUrl(video.filename), now + SHARED_OVERLAY_LEAD_MS);
    res.json({ ok: true, triggered: true, reached });
  } catch (err) {
    log.error('Failed to trigger shared video:', err);
    res.status(500).json({ ok: false, error: 'Failed to trigger video' });
  }
});

/**
 * Resets the cooldown. Exported for tests only.
 */
export function resetSharedVideoCooldown(): void {
  lastTriggerAt = 0;
}

export default router;
