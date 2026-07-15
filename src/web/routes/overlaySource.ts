import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import fs from 'fs';
import { OVERLAY_FOLDER, OVERLAY_MAX_SSE_PER_CHANNEL } from '../../shared/config';
import { safeResolve } from '../../shared/pathUtils';
import { renderView } from './shared';
import { createSseEventsHandler } from './sseChannel';

const log = createLogger('OverlaySource');
const router = Router();

const LOGIN_RE = /^[a-zA-Z0-9_]{1,25}$/;
const FILENAME_RE = /^[\w-]+\.(webm|mp4)$/i;
// Words reserved for admin routes — must not be treated as channel logins.
const RESERVED_LOGINS = new Set(['settings', 'videos', 'controller']);

// In-memory map of active SSE connections keyed by Twitch channel login (lowercase).
export const connections = new Map<string, Set<import('express').Response>>();

export const MAX_SSE_CONNECTIONS_PER_CHANNEL = OVERLAY_MAX_SSE_PER_CHANNEL;

/** Push a video URL to all browser sources connected for this channel. */
export function pushOverlayEvent(login: string, videoPath: string): void {
  const key = login.toLowerCase();
  const clients = connections.get(key);
  if (!clients || clients.size === 0) return;
  const payload = JSON.stringify({ video: videoPath });
  const dead: import('express').Response[] = [];
  for (const res of clients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      dead.push(res);
    }
  }
  for (const res of dead) clients.delete(res);
  if (clients.size === 0) connections.delete(key);
  log.info(`Pushed overlay event to ${clients.size} client(s) for ${login}`);
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
  const { login } = req.params;
  if (!LOGIN_RE.test(login) || RESERVED_LOGINS.has(login.toLowerCase())) { next(); return; }
  renderView(res, 'overlaySource', { login: login.toLowerCase() });
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
 *   down on client disconnect; replies 429 if the channel's connection limit
 *   (`MAX_SSE_CONNECTIONS_PER_CHANNEL`) is exceeded, or calls `next()` if
 *   `login` is malformed or reserved.
 */
router.get('/:login/events', createSseEventsHandler({
  connections,
  loginRe: LOGIN_RE,
  reservedLogins: RESERVED_LOGINS,
  maxPerChannel: MAX_SSE_CONNECTIONS_PER_CHANNEL,
}));

/**
 * GET /overlay/videos/:streamerId/:filename — serves an overlay video file
 * from disk (no auth; URLs are unguessable UUID filenames).
 * @param req - Express request; reads the `streamerId` and `filename` route
 *   params.
 * @param res - Express response; sends the file on success, or replies 400 if
 *   `streamerId`/`filename` are malformed or the resolved path is unsafe, or
 *   404 if the file doesn't exist.
 */
router.get('/videos/:streamerId/:filename', async (req, res) => {
  const { streamerId, filename } = req.params;

  if (!/^\d+$/.test(streamerId)) { res.status(400).end(); return; }
  if (!FILENAME_RE.test(filename)) { res.status(400).end(); return; }

  const resolved = safeResolve(OVERLAY_FOLDER, streamerId, filename);
  if (!resolved) { res.status(400).end(); return; }

  try {
    await fs.promises.access(resolved);
  } catch {
    res.status(404).end();
    return;
  }

  res.sendFile(resolved);
});

export default router;
