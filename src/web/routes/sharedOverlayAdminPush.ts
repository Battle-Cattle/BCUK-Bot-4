import { Router } from 'express';
import { createLogger } from '../../shared/logger';
import { SHARED_OVERLAY_PUSH_COOLDOWN_MS } from '../../shared/config';
import { csrfProtection } from '../csrf';
import { getSharedVideo } from '../../db';
import { parsePositiveIntId } from './validation';
import { logAndRedirectError } from './errorHandling';
import { broadcastSharedEvent, sharedVideoUrl } from './sharedOverlaySource';
import { SHARED_SETTINGS_PATH } from './sharedOverlayAdminShared';

// Manager push (#917): makes every connected shared overlay that lacks a video download it now, at
// full speed, without playing it. Mounted by sharedOverlayAdmin.ts behind the Manager gate.

const log = createLogger('SharedOverlayAdminPush');
export const router = Router();

/** Time of the last accepted push per video id, for the per-video cooldown (single process). */
const lastPushAt = new Map<number, number>();

/**
 * POST /overlay/shared/settings/videos/:id/push — sends `{ type: 'fetchNow', url }` to every
 * connected shared overlay. Each one that does not have the video stored downloads it straight
 * away; it never plays it. Only enabled videos, and the same video only once per cooldown so
 * repeated clicks do not restart downloads. Overlays that are not connected pick the video up
 * through the normal sync when they next connect.
 * @param req - Express request; reads the `id` route param.
 * @param res - Redirects to the settings page with `?success=video_pushed&pushed=<overlays reached>`,
 *   or `?error=` `invalid_id`, `not_found`, `video_disabled`, `push_cooldown` or `save_failed`.
 */
router.post('/videos/:id/push', csrfProtection, async (req, res) => {
  try {
    const id = parsePositiveIntId(req.params.id);
    if (id === null) return res.redirect(`${SHARED_SETTINGS_PATH}?error=invalid_id`);
    const video = await getSharedVideo(id);
    if (!video) return res.redirect(`${SHARED_SETTINGS_PATH}?error=not_found`);
    if (!video.enabled) return res.redirect(`${SHARED_SETTINGS_PATH}?error=video_disabled`);
    const now = Date.now();
    // Checked and set with no await between, so two clicks at once cannot both pass.
    if (now - (lastPushAt.get(id) ?? 0) < SHARED_OVERLAY_PUSH_COOLDOWN_MS) {
      return res.redirect(`${SHARED_SETTINGS_PATH}?error=push_cooldown`);
    }
    lastPushAt.set(id, now);
    const reached = broadcastSharedEvent({ type: 'fetchNow', url: sharedVideoUrl(video.filename) });
    log.info(`Shared video ${id} pushed to ${reached} overlay(s)`);
    res.redirect(`${SHARED_SETTINGS_PATH}?success=video_pushed&pushed=${reached}`);
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Shared video push error:', err, basePath: SHARED_SETTINGS_PATH, errorCode: 'save_failed' });
  }
});

/**
 * Forgets every push time. Exported for tests only.
 */
export function resetPushCooldowns(): void {
  lastPushAt.clear();
}
