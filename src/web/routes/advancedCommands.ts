// /advanced-commands: the signed-in streamer's own advanced commands. Self-service only, like
// Loyalty Points — every route resolves the session user's streamer record and only ever touches
// that streamer's commands. The page itself is here; the writes are in advancedCommandMutations.ts
// and the alert image/sound uploads in advancedCommandAlertAssets.ts.
import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  findUser,
  getLoyaltyPointsConfig,
  getStreamerByDiscordId,
  getVideosForStreamer,
  listAdvancedCommands,
  listRecentAdvancedCommandUsage,
  ADVANCED_COMMAND_ROLES,
  ALERT_TEXT_ANIMATIONS,
  MAX_ADVANCED_COMMAND_PARAMS,
} from '../../db';
import { ALERT_MAX_IMAGE_MB, ALERT_MAX_SOUND_MB } from '../../shared/config';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { renderView, renderError } from './viewHelpers';
import { filterQueryParam } from './validation';
import { router as mutationsRouter } from './advancedCommandMutations';
import { router as alertAssetsRouter } from './advancedCommandAlertAssets';

const log = createLogger('Web');
const router = Router();

const USAGE_LOG_SIZE = 50;

/** Every `?error=` code the page knows how to describe; anything else is dropped. */
const KNOWN_ERRORS = new Set([
  'not_a_streamer', 'save_failed', 'not_found', 'invalid_number', 'invalid_name', 'invalid_trigger',
  'invalid_response', 'invalid_point_cost', 'invalid_price_step', 'invalid_max_cost', 'invalid_global_cooldown',
  'invalid_user_cooldown', 'invalid_max_uses', 'invalid_max_user_uses', 'invalid_role', 'duplicate_name',
  'duplicate_trigger', 'trigger_taken', 'reserved_trigger', 'too_many_params', 'invalid_param',
  'invalid_alert_message', 'invalid_alert_duration', 'invalid_alert_animation', 'invalid_file', 'invalid_path',
  'file_too_large', 'upload_failed', 'no_alert', 'test_failed', 'command_disabled',
]);

/** Every `?success=` code the page shows a confirmation for. */
const KNOWN_SUCCESSES = new Set([
  'added', 'saved', 'effects_saved', 'removed', 'toggled', 'image_uploaded', 'sound_uploaded',
  'image_deleted', 'sound_deleted', 'test_sent',
]);

/**
 * GET /advanced-commands — renders the signed-in streamer's advanced commands, their effects,
 * the usage log, and the form to add one. A signed-in user who isn't a streamer sees an
 * explanation instead, like the Loyalty Points page.
 * @param req - Express request; reads `?error=`/`?success=`.
 * @param res - Renders `advancedCommands`, or a 500 error page.
 */
router.get('/advanced-commands', requireAuth, csrfProtection, async (req, res) => {
  try {
    const discordId = getSessionUser(req).discordId;
    const [user, streamer] = await Promise.all([findUser(discordId), getStreamerByDiscordId(discordId)]);
    const [commands, videos, usage, pointsConfig] = streamer
      ? await Promise.all([
        listAdvancedCommands(streamer.id),
        getVideosForStreamer(streamer.id),
        listRecentAdvancedCommandUsage(streamer.id, USAGE_LOG_SIZE),
        getLoyaltyPointsConfig(streamer.id),
      ])
      : [[], [], [], null];

    renderView(res, 'advancedCommands', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      isStreamer: !!streamer,
      streamerId: streamer?.id ?? null,
      twitchLinked: !!user?.twitch_name,
      chatBotEnabled: !!user?.is_twitch_bot_enabled,
      loyaltyPointsEnabled: !!pointsConfig?.enabled,
      commands,
      videos,
      usage,
      roles: ADVANCED_COMMAND_ROLES,
      textAnimations: ALERT_TEXT_ANIMATIONS,
      maxParams: MAX_ADVANCED_COMMAND_PARAMS,
      maxImageMb: ALERT_MAX_IMAGE_MB,
      maxSoundMb: ALERT_MAX_SOUND_MB,
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
      success: filterQueryParam(req.query.success, KNOWN_SUCCESSES),
    });
  } catch (err) {
    log.error('Advanced commands page error:', err);
    renderError(res, 500, 'Failed to load advanced commands.', req.session.user);
  }
});

router.use(mutationsRouter);
router.use(alertAssetsRouter);

export default router;
