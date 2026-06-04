import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import fs from 'fs';
import { OVERLAY_FOLDER } from '../../shared/config';
import { safeResolve } from '../../shared/pathUtils';

const log = createLogger('OverlaySource');
const router = Router();

const LOGIN_RE = /^[a-zA-Z0-9_]{1,25}$/;
const FILENAME_RE = /^[\w-]+\.(webm|mp4)$/i;
// Words reserved for admin routes — must not be treated as channel logins.
const RESERVED_LOGINS = new Set(['settings', 'videos']);

// In-memory map of active SSE connections keyed by Twitch channel login (lowercase).
const connections = new Map<string, Set<import('express').Response>>();

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

// GET /overlay/:login — browser source HTML page (no auth, opened by OBS)
router.get('/:login', (req, res, next) => {
  const { login } = req.params;
  if (!LOGIN_RE.test(login) || RESERVED_LOGINS.has(login.toLowerCase())) { next(); return; }
  res.render('overlaySource', { login: login.toLowerCase() });
});

// GET /overlay/:login/events — SSE endpoint
router.get('/:login/events', (req, res, next) => {
  const { login } = req.params;
  if (!LOGIN_RE.test(login) || RESERVED_LOGINS.has(login.toLowerCase())) { next(); return; }
  const key = login.toLowerCase();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering if behind proxy
  res.flushHeaders();

  res.write(': connected\n\n');

  if (!connections.has(key)) connections.set(key, new Set());
  connections.get(key)!.add(res);

  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepalive);
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

// GET /overlay/videos/:streamerId/:filename — serve video files (no auth)
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
