import { createLogger } from '../../shared/logger';
import { Router, type Response } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { getStreamerByDiscordId, getAlertConfigsForStreamer, ALERT_EVENT_TYPES, ALERT_TEXT_ANIMATIONS } from '../../db';
import type { DbStreamerEventSub } from '../../db';
import { PUBLIC_URL, ALERT_STATUS_MAX_SSE_PER_STREAMER } from '../../shared/config';
import { filterQueryParam } from './validation';
import { renderError, renderView } from './viewHelpers';
import { router as mutationsRouter } from './alertsAdminMutations';
import { router as assetMutationsRouter, MAX_IMAGE_MB, MAX_SOUND_MB } from './alertsAssetMutations';
import { connections as alertsSourceConnections } from './alertsOverlaySource';
import { attachSseConnection, broadcastToChannel } from './sseChannel';

const log = createLogger('AlertsAdmin');
const router = Router();

// How often the settings-page SSE stream re-checks whether the overlay browser source is open.
const STATUS_POLL_INTERVAL_MS = 3000;

// In-memory map of active `/settings/events` SSE connections, keyed by streamer ID.
export const statusConnections = new Map<number, Set<Response>>();

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
    const configByType = Object.fromEntries(configs.map((c) => [c.event_type, c]));

    renderView(res, 'alertsAdmin', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      streamer: streamer ?? null,
      eventTypes: ALERT_EVENT_TYPES,
      textAnimations: ALERT_TEXT_ANIMATIONS,
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

/**
 * GET /alerts/settings/events — SSE endpoint streaming `{ connected: boolean }` snapshots of
 * whether the logged-in user's own alerts browser source currently has an open connection, so the
 * settings page can show a live status dot instead of the user only finding out something's wrong
 * when an alert never fires. Polls the shared `alertsOverlaySource` connections map on an interval
 * rather than reacting to a push event, since opening/closing that overlay's SSE connection has no
 * existing event to subscribe to.
 * @param req - Express request; reads `req.session.user`.
 * @param res - Express response; upgrades to a `text/event-stream` connection kept alive with
 *   periodic pings and torn down (including the status-poll interval) on client disconnect;
 *   replies 403 if the user isn't a monitored streamer with a linked Twitch channel, 500 (logged)
 *   if the streamer lookup fails, or 429 if the connection limit is exceeded.
 */
router.get('/settings/events', requireAuth, async (req, res) => {
  let streamer: DbStreamerEventSub | null;
  try {
    streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
  } catch (err) {
    log.error('Failed to resolve streamer for alerts status SSE:', err);
    res.status(500).end();
    return;
  }
  if (!streamer || !streamer.twitch_name) {
    res.status(403).end();
    return;
  }

  const attached = attachSseConnection(req, res, {
    connections: statusConnections,
    key: streamer.id,
    maxPerChannel: ALERT_STATUS_MAX_SSE_PER_STREAMER,
  });
  if (!attached) return;

  const streamerId = streamer.id;
  const login = streamer.twitch_name.toLowerCase();
  let lastConnected: boolean | null = null;

  const check = (): void => {
    const isConnected = (alertsSourceConnections.get(login)?.size ?? 0) > 0;
    if (isConnected === lastConnected) return;
    lastConnected = isConnected;
    broadcastToChannel(statusConnections, streamerId, { connected: isConnected });
  };

  check();
  const interval = setInterval(check, STATUS_POLL_INTERVAL_MS);
  req.on('close', () => clearInterval(interval));
});

router.use(mutationsRouter);
router.use(assetMutationsRouter);

export default router;
