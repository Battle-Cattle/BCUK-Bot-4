import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { saveAlertConfig, getAlertConfig } from '../../db';
import { logAndRedirectError, requireStreamer, parseCheckboxField } from './shared';
import { pushAlertEvent } from './alertsOverlaySource';
import { NOT_A_STREAMER_REDIRECT, parseEventType } from './alertsShared';
import { reloadEventSubSubscriptions } from '../../twitch/eventsub/twitchEventSub';

const log = createLogger('AlertsAdmin');
export const router = Router();

/**
 * POST /alerts/settings/:eventType — saves the non-file fields (enable flag, message template,
 * display duration) of one of the requesting streamer's alert configs, then reloads EventSub
 * subscriptions so an alert-only `enabled` flip (with no chat-message flag on) takes effect
 * immediately rather than waiting for some unrelated reload trigger — mirrors the same call
 * after `saveEventConfig` in `userSettings.ts`.
 * @param req - Express request; reads the `eventType` route param and `enabled`,
 *   `message_template`, `duration_ms` fields from `req.body`.
 * @param res - Express response; redirects to `/alerts/settings?success=config_saved` on
 *   success, or to `/alerts/settings?error=<code>` if the requester isn't a streamer
 *   (`not_a_streamer`), `eventType` is invalid (`invalid_event_type`), the message template is
 *   blank (`invalid_message`), or saving fails (`save_failed`).
 */
router.post('/settings/:eventType', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const eventType = parseEventType(req.params.eventType);
    if (!eventType) return res.redirect('/alerts/settings?error=invalid_event_type');

    const messageTemplate = (typeof req.body?.message_template === 'string' ? req.body.message_template : '').trim().slice(0, 500);
    if (messageTemplate.length === 0) return res.redirect('/alerts/settings?error=invalid_message');

    const durationRaw = Number(req.body?.duration_ms);
    const durationMs = Number.isInteger(durationRaw) ? Math.min(60_000, Math.max(1000, durationRaw)) : 6000;

    await saveAlertConfig(streamer.id, eventType, {
      enabled: parseCheckboxField(req.body?.enabled),
      message_template: messageTemplate,
      duration_ms: durationMs,
    });
    reloadEventSubSubscriptions();

    res.redirect('/alerts/settings?success=config_saved');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Alert config save error:', err, basePath: '/alerts/settings', errorCode: 'save_failed' });
  }
});

/**
 * POST /alerts/settings/:eventType/test — pushes the requesting streamer's actual saved
 * configuration (message template, image, sound, duration) for one event type through their
 * alerts-overlay SSE stream, so they can preview their real setup live in OBS without waiting
 * for a real Twitch event. Falls back to a generic message if no config row exists yet.
 * @param req - Express request; reads the `eventType` route param.
 * @param res - Express response; redirects to `/alerts/settings?success=test_sent` on success,
 *   or to `/alerts/settings?error=<code>` if the requester isn't a streamer
 *   (`not_a_streamer`), `eventType` is invalid (`invalid_event_type`), or they have no Twitch
 *   channel connected to push to (`not_a_streamer`).
 */
router.post('/settings/:eventType/test', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const eventType = parseEventType(req.params.eventType);
    if (!eventType) return res.redirect('/alerts/settings?error=invalid_event_type');
    if (!streamer.twitch_name) return res.redirect(NOT_A_STREAMER_REDIRECT);

    const config = await getAlertConfig(streamer.id, eventType);

    pushAlertEvent(streamer.twitch_name.toLowerCase(), {
      type: eventType,
      message: config ? `[Test] ${config.message_template}` : `Test alert — ${eventType}`,
      imageUrl: config?.image_filename ? `/alerts/assets/${streamer.id}/${config.image_filename}` : null,
      soundUrl: config?.sound_filename ? `/alerts/assets/${streamer.id}/${config.sound_filename}` : null,
      durationMs: config?.duration_ms ?? 6000,
    });

    res.redirect('/alerts/settings?success=test_sent');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Alert test-send error:', err, basePath: '/alerts/settings', errorCode: 'save_failed' });
  }
});

export default router;
