import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import fs from 'fs';
import type { AlertPayload } from '../../twitch/eventsub/twitchEventSubHandler';
import { ALERT_ASSETS_FOLDER, ALERT_MAX_SSE_PER_CHANNEL } from '../../shared/config';
import { safeResolve } from '../../shared/pathUtils';
import { renderView } from './shared';

const log = createLogger('AlertsOverlaySource');
const router = Router();

const LOGIN_RE = /^[a-zA-Z0-9_]{1,25}$/;
const FILENAME_RE = /^[\w-]+\.(png|gif|jpe?g|webp|mp3|ogg|wav)$/i;
// Words reserved for admin/asset routes — must not be treated as channel logins.
const RESERVED_LOGINS = new Set(['settings', 'assets']);

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
  const clients = connections.get(key);
  if (!clients || clients.size === 0) return;
  const payload = JSON.stringify(alert);
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
  log.info(`Pushed alert event to ${clients.size} client(s) for ${login}`);
}

/**
 * GET /alerts/:login — renders the alerts-overlay browser source HTML page for a Twitch
 * channel login (no auth, opened directly by OBS).
 * @param req - Express request; reads the `login` route param.
 * @param res - Express response; renders the `alertsOverlaySource` view, or calls `next()`
 *   to fall through to later routes if `login` is malformed or reserved (`settings`, `assets`).
 */
router.get('/:login', (req, res, next) => {
  const { login } = req.params;
  if (!LOGIN_RE.test(login) || RESERVED_LOGINS.has(login.toLowerCase())) { next(); return; }
  renderView(res, 'alertsOverlaySource', { login: login.toLowerCase() });
});

/**
 * GET /alerts/:login/events — SSE endpoint that streams `pushAlertEvent` alert notifications
 * to a connected browser source for a channel login (no auth, opened directly by OBS).
 * @param req - Express request; reads the `login` route param.
 * @param res - Express response; on a valid login, upgrades to an `text/event-stream`
 *   connection kept alive with periodic pings and torn down on client disconnect; replies
 *   429 if the channel's connection limit (`MAX_SSE_CONNECTIONS_PER_CHANNEL`) is exceeded,
 *   or calls `next()` if `login` is malformed or reserved.
 */
router.get('/:login/events', (req, res, next) => {
  const { login } = req.params;
  if (!LOGIN_RE.test(login) || RESERVED_LOGINS.has(login.toLowerCase())) { next(); return; }
  const key = login.toLowerCase();

  if (!connections.has(key)) connections.set(key, new Set());
  const clients = connections.get(key)!;
  clients.add(res);
  if (clients.size > MAX_SSE_CONNECTIONS_PER_CHANNEL) {
    clients.delete(res);
    res.status(429).end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering if behind proxy
  res.flushHeaders();

  res.write(': connected\n\n');

  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepalive);
      const clients = connections.get(key);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) connections.delete(key);
      }
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepalive);
    const clients = connections.get(key);
    if (!clients) return;
    clients.delete(res);
    if (clients.size === 0) connections.delete(key);
  });
});

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
  res.sendFile(resolved);
});

export default router;
