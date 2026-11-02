import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { OVERLAY_FOLDER, OVERLAY_MAX_SSE_PER_CHANNEL } from '../../shared/config';
import { renderView } from './viewHelpers';
import { resolveStreamerFile, sendStreamerFile } from './streamerFileServing';
import { broadcastToChannel } from './sseChannel';
import { createSseEventsHandler, createLoginValidator } from './sseEventsHandlers';

const log = createLogger('OverlaySource');
const router = Router();

const LOGIN_RE = /^[a-zA-Z0-9_]{1,25}$/;
const FILENAME_RE = /^[\w-]+\.(webm|mp4)$/i;
// Words reserved for admin routes — must not be treated as channel logins.
const RESERVED_LOGINS = new Set(['settings', 'videos', 'controller']);
// Shared by the plain browser-source route below and the /events SSE route, so both apply the
// identical login-validity rule from one place.
const isValidLogin = createLoginValidator(LOGIN_RE, RESERVED_LOGINS);

// In-memory map of active SSE connections keyed by Twitch channel login (lowercase).
export const connections = new Map<string, Set<import('express').Response>>();

export const MAX_SSE_CONNECTIONS_PER_CHANNEL = OVERLAY_MAX_SSE_PER_CHANNEL;

/**
 * Push a video URL to all browser sources connected for this channel.
 * @param login - Twitch channel login the overlay is keyed by (matched case-insensitively).
 * @param videoPath - URL path of the video for the browser source to play.
 */
export function pushOverlayEvent(login: string, videoPath: string): void {
  const key = login.toLowerCase();
  const remaining = broadcastToChannel(connections, key, { video: videoPath });
  if (remaining !== null) log.info(`Pushed overlay event to ${remaining} client(s) for ${login}`);
}

/**
 * GET /overlay/controller — renders the Forza/gamepad controller browser
 * source page (no auth, opened directly by OBS).
 * @param _req - Express request (unused).
 * @param res - Express response; renders the `controllerOverlay` view.
 */
router.get('/controller', (_req, res) => {
  renderView(res, 'controllerOverlay');
});

/**
 * GET /overlay/:login — renders the video-overlay browser source HTML page
 * for a Twitch channel login (no auth, opened directly by OBS).
 * @param req - Express request; reads the `login` route param.
 * @param res - Express response; renders the `overlaySource` view, or calls
 *   `next()` to fall through to later routes if `login` is malformed or
 *   reserved (e.g. `settings`, `videos`, `controller`).
 */
router.get('/:login', (req, res, next) => {
  const login = isValidLogin(req.params.login);
  if (login === null) { next(); return; }
  renderView(res, 'overlaySource', { login });
});

/**
 * GET /overlay/:login/events — SSE endpoint that streams `pushOverlayEvent`
 * video notifications to a connected browser source for a channel login (no
 * auth, opened directly by OBS).
 * Connection lifecycle (validation, connection-limit enforcement, SSE handshake, keepalive,
 * and disconnect cleanup) is shared with the alerts overlay via `createSseEventsHandler`.
 * @param req - Express request; reads the `login` route param.
 * @param res - Express response; on a valid login, upgrades to an
 *   `text/event-stream` connection kept alive with periodic pings and torn
 *   down on client disconnect; replies 404 if `login` isn't a registered
 *   streamer, 429 if the channel's connection limit
 *   (`MAX_SSE_CONNECTIONS_PER_CHANNEL`) or the shared unauthenticated-overlay
 *   pool's total/per-IP limit is exceeded, or calls `next()` if `login` is
 *   malformed or reserved.
 */
router.get('/:login/events', createSseEventsHandler({
  connections,
  isValidLogin,
  maxPerChannel: MAX_SSE_CONNECTIONS_PER_CHANNEL,
}));

/**
 * GET /overlay/videos/:streamerId/:filename — serves an overlay video file
 * from disk (no auth; URLs are unguessable UUID filenames).
 * @param req - Express request; reads the `streamerId` and `filename` route
 *   params.
 * @param res - Express response; sends the file on success, or replies 400 if
 *   `streamerId`/`filename` are malformed or the resolved path is unsafe, or
 *   404 if the file doesn't exist or its real path (following symlinks) is
 *   outside the overlay folder.
 */
router.get('/videos/:streamerId/:filename', async (req, res) => {
  const file = await resolveStreamerFile(res, OVERLAY_FOLDER, req.params, FILENAME_RE);
  if (file) sendStreamerFile(res, file.realPath);
});

export default router;
