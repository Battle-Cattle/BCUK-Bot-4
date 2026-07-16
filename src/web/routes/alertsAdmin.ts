import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { getStreamerByDiscordId, getAlertConfigsForStreamer, ALERT_EVENT_TYPES } from '../../db';
import { PUBLIC_URL } from '../../shared/config';
import { filterQueryParam, renderError, renderView } from './shared';
import { router as mutationsRouter } from './alertsAdminMutations';
import { router as assetMutationsRouter, MAX_IMAGE_MB, MAX_SOUND_MB } from './alertsAssetMutations';

const log = createLogger('AlertsAdmin');
const router = Router();

const KNOWN_ERRORS = new Set([
  'not_a_streamer', 'invalid_event_type', 'invalid_file', 'invalid_message',
  'upload_failed', 'delete_failed', 'save_failed', 'invalid_path', 'file_too_large',
]);
const KNOWN_SUCCESSES = new Set([
  'image_uploaded', 'sound_uploaded', 'image_deleted', 'sound_deleted', 'config_saved', 'test_sent',
]);

/**
 * GET /alerts/settings — renders the alerts overlay settings page with the user's alert
 * configuration for every event type (follow/sub/resub/giftsub/raid), if they are a
 * monitored streamer.
 * @param req - Express request; reads `req.session.user`, `error`, and `success` query params.
 * @param res - Express response; renders the `alertsAdmin` view, or a 500 error page if
 *   loading settings fails.
 */
router.get('/settings', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
    const configs = streamer ? await getAlertConfigsForStreamer(streamer.id) : [];
    const configByType = new Map(configs.map((c) => [c.event_type, c]));

    renderView(res, 'alertsAdmin', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      streamer: streamer ?? null,
      eventTypes: ALERT_EVENT_TYPES,
      configByType,
      baseUrl: PUBLIC_URL,
      maxImageMb: MAX_IMAGE_MB,
      maxSoundMb: MAX_SOUND_MB,
      error:   filterQueryParam(req.query.error,   KNOWN_ERRORS),
      success: filterQueryParam(req.query.success, KNOWN_SUCCESSES),
    });
  } catch (err) {
    log.error('Alerts settings page error:', err);
    renderError(res, 500, 'Failed to load alerts settings.', req.session.user);
  }
});

router.use(mutationsRouter);
router.use(assetMutationsRouter);

export default router;
