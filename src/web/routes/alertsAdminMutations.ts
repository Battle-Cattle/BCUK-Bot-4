import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { saveAlertConfig, getAlertConfig, ALERT_TEXT_ANIMATIONS } from '../../db';
import { logAndRedirectError, requireStreamer, parseCheckboxField } from './shared';
import { pushAlertEvent } from './alertsOverlaySource';
import { NOT_A_STREAMER_REDIRECT, parseEventType, parseEnumField } from './alertsShared';
import { reloadEventSubSubscriptions } from '../../twitch/eventsub/twitchEventSub';
import { fillTemplate } from '../../shared/textTemplate';
import { TEST_ALERT_VARS } from './testAlertVars';

const log = createLogger('AlertsAdmin');
export const router = Router();

/**
 * POST /alerts/settings/:eventType — saves the non-file fields (enable flag, message template,
 * display duration, text animation) of one of the requesting streamer's alert configs, then
 * reloads EventSub subscriptions so an alert-only `enabled` flip (with no chat-message flag on)
 * takes effect immediately rather than waiting for some unrelated reload trigger — mirrors the
 * same call after `saveEventConfig` in `userSettings.ts`.
 * @param req - Express request; reads the `eventType` route param and `enabled`,
 *   `message_template`, `duration_seconds`, `text_animation` fields from `req.body`. The
 *   settings page shows/submits duration in seconds (the unit streamers actually reason about,
 *   0.01s increments) — this route is the only place the seconds→ms conversion happens, so a
 *   streamer's edit is never dependent on client JS running to take effect.
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

    const secondsRaw = Number(req.body?.duration_seconds);
    const durationMs = Number.isFinite(secondsRaw)
      ? Math.round(Math.min(60, Math.max(1, secondsRaw)) * 1000)
      : 6000;

    await saveAlertConfig(streamer.id, eventType, {
      enabled: parseCheckboxField(req.body?.enabled),
      message_template: messageTemplate,
      duration_ms: durationMs,
      text_animation: parseEnumField(req.body?.text_animation, ALERT_TEXT_ANIMATIONS, 'none'),
    });
    reloadEventSubSubscriptions();

    res.redirect('/alerts/settings?success=config_saved');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Alert config save error:', err, basePath: '/alerts/settings', errorCode: 'save_failed' });
  }
});

/**
 * POST /alerts/settings/:eventType/test — pushes the requesting streamer's actual saved
 * configuration (message template, image, sound, duration, text animation) for one event type
 * through their alerts-overlay SSE stream, so they can preview their real setup live in OBS
 * without waiting for a real Twitch event. The message template's placeholders are filled with
 * realistic sample values (see {@link TEST_ALERT_VARS}) — same as a real event — rather than
 * left as raw `{placeholder}` text, so the streamer can actually see whether their template
 * reads correctly; any placeholder not recognised for the event type is left in place (via
 * `fillTemplate`'s `'keep'` fallback, matching `maybePushAlert`'s fallback for a real event) as
 * a hint of a possible typo — this preview is a faithful match for what a real event will
 * actually render, not just an approximation. Falls back to a generic message if no config row
 * exists yet.
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
    const message = config
      ? `[Test] ${fillTemplate(config.message_template, TEST_ALERT_VARS[eventType], 'keep')}`
      : `Test alert — ${eventType}`;

    pushAlertEvent(streamer.twitch_name.toLowerCase(), {
      type: eventType,
      message,
      imageUrl: config?.image_filename ? `/alerts/assets/${streamer.id}/${config.image_filename}` : null,
      soundUrl: config?.sound_filename ? `/alerts/assets/${streamer.id}/${config.sound_filename}` : null,
      durationMs: config?.duration_ms ?? 6000,
      textAnimation: config?.text_animation ?? 'none',
    });

    res.redirect('/alerts/settings?success=test_sent');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Alert test-send error:', err, basePath: '/alerts/settings', errorCode: 'save_failed' });
  }
});
