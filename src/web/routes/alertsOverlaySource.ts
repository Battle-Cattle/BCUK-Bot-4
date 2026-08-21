import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import fs from 'fs';
import type { AlertPayload } from '../../twitch/eventsub/twitchEventSubRuntime';
import { ALERT_ASSETS_FOLDER, ALERT_MAX_SSE_PER_CHANNEL } from '../../shared/config';
import { safeResolve } from '../../shared/pathUtils';
import { renderView } from './viewHelpers';
import { createSseEventsHandler, createLoginValidator, broadcastToChannel } from './sseChannel';

const log = createLogger('AlertsOverlaySource');
const router = Router();

const LOGIN_RE = /^[a-zA-Z0-9_]{1,25}$/;
const FILENAME_RE = /^[\w-]+\.(png|gif|jpe?g|webp|mp3|ogg|wav)$/i;
// Words reserved for admin/asset routes — must not be treated as channel logins.
const RESERVED_LOGINS = new Set(['settings', 'assets']);
// Shared by the plain browser-source route below and the /events SSE route, so both apply the
// identical login-validity rule from one place.
const isValidLogin = createLoginValidator(LOGIN_RE, RESERVED_LOGINS);

/** Maps a detected asset file extension to its `Content-Type` — never derived from client input. */
const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

// In-memory map of active SSE connections keyed by Twitch channel login (lowercase).
export const connections = new Map<string, Set<import('express').Response>>();

export const MAX_SSE_CONNECTIONS_PER_CHANNEL = ALERT_MAX_SSE_PER_CHANNEL;

/** Push a customisable alert to all browser sources connected for this channel. */
export function pushAlertEvent(login: string, alert: AlertPayload): void {
  const key = login.toLowerCase();
  const remaining = broadcastToChannel(connections, key, alert);
  if (remaining !== null) log.info(`Pushed alert event to ${remaining} client(s) for ${login}`);
}

/**
 * GET /alerts/:login — renders the alerts-overlay browser source HTML page for a Twitch
 * channel login (no auth, opened directly by OBS).
 * @param req - Express request; reads the `login` route param.
 * @param res - Express response; renders the `alertsOverlaySource` view, or calls `next()`
 *   to fall through to later routes if `login` is malformed or reserved (`settings`, `assets`).
 */
router.get('/:login', (req, res, next) => {
  const login = isValidLogin(req.params.login);
  if (login === null) { next(); return; }
  renderView(res, 'alertsOverlaySource', { login });
});

/**
 * GET /alerts/:login/events — SSE endpoint that streams `pushAlertEvent` alert notifications
 * to a connected browser source for a channel login (no auth, opened directly by OBS).
 * Connection lifecycle (validation, connection-limit enforcement, SSE handshake, keepalive,
 * and disconnect cleanup) is shared with the reward-video overlay via `createSseEventsHandler`.
 * @param req - Express request; reads the `login` route param.
 * @param res - Express response; on a valid login, upgrades to an `text/event-stream`
 *   connection kept alive with periodic pings and torn down on client disconnect; replies
 *   429 if the channel's connection limit (`MAX_SSE_CONNECTIONS_PER_CHANNEL`) is exceeded,
 *   or calls `next()` if `login` is malformed or reserved.
 */
router.get('/:login/events', createSseEventsHandler({
  connections,
  isValidLogin,
  maxPerChannel: MAX_SSE_CONNECTIONS_PER_CHANNEL,
}));

/**
 * GET /alerts/assets/:streamerId/:filename — serves an uploaded alert image/GIF/sound file
 * from disk (no auth; URLs are unguessable UUID-based filenames).
 * @param req - Express request; reads the `streamerId` and `filename` route params.
 * @param res - Express response; sends the file (with a detected-type `Content-Type` and
 *   `X-Content-Type-Options: nosniff`) on success, or replies 400 if `streamerId`/`filename`
 *   are malformed or the resolved path is unsafe, or 404 if the file doesn't exist.
 */
router.get('/assets/:streamerId/:filename', async (req, res) => {
  const { streamerId, filename } = req.params;

  if (!/^\d+$/.test(streamerId)) { res.status(400).end(); return; }
  const match = FILENAME_RE.exec(filename);
  if (!match) { res.status(400).end(); return; }

  const resolved = safeResolve(ALERT_ASSETS_FOLDER, streamerId, filename);
  if (!resolved) { res.status(400).end(); return; }

  try {
    await fs.promises.access(resolved);
  } catch {
    res.status(404).end();
    return;
  }

  const ext = match[1].toLowerCase();
  res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // A TOCTOU race is possible here: the file can be removed (e.g. via the delete-asset route)
  // between the access() check above and sendFile() actually reading it. Passing a callback
  // stops Express from falling through to the default error handler (a 500) for that race —
  // reply 404 instead, as long as headers haven't already gone out.
  res.sendFile(resolved, (err) => {
    if (err && !res.headersSent) {
      res.status(404).end();
    }
  });
});

export default router;
