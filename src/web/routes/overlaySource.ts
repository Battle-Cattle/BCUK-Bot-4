import { createLogger } from '../../logger';
import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { OVERLAY_FOLDER } from '../../config';

const log = createLogger('OverlaySource');
const router = Router();

const LOGIN_RE = /^[a-zA-Z0-9_]{1,25}$/;
const FILENAME_RE = /^[\w-]+\.(webm|mp4)$/i;

// In-memory map of active SSE connections keyed by Twitch channel login (lowercase).
const connections = new Map<string, Set<import('express').Response>>();

/** Push a video URL to all browser sources connected for this channel. */
export function pushOverlayEvent(login: string, videoPath: string): void {
  const clients = connections.get(login.toLowerCase());
  if (!clients || clients.size === 0) return;
  const payload = JSON.stringify({ video: videoPath });
  for (const res of clients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      // Client disconnected — will be cleaned up by the close handler
    }
  }
  log.info(`Pushed overlay event to ${clients.size} client(s) for ${login}`);
}

// GET /overlay/:login — browser source HTML page (no auth, opened by OBS)
router.get('/:login', (req, res) => {
  const { login } = req.params;
  if (!LOGIN_RE.test(login)) { res.status(400).end(); return; }
  res.render('overlaySource', { login: login.toLowerCase() });
});

// GET /overlay/:login/events — SSE endpoint
router.get('/:login/events', (req, res) => {
  const { login } = req.params;
  if (!LOGIN_RE.test(login)) { res.status(400).end(); return; }
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
    connections.get(key)?.delete(res);
  });
});

// GET /overlay/videos/:streamerId/:filename — serve video files (no auth)
router.get('/videos/:streamerId/:filename', (req, res) => {
  const { streamerId, filename } = req.params;

  if (!/^\d+$/.test(streamerId)) { res.status(400).end(); return; }
  if (!FILENAME_RE.test(filename)) { res.status(400).end(); return; }

  const filePath = path.join(OVERLAY_FOLDER, streamerId, filename);
  const resolved = path.resolve(filePath);
  const base = path.resolve(OVERLAY_FOLDER);
  if (!resolved.startsWith(base + path.sep)) { res.status(400).end(); return; }

  if (!fs.existsSync(resolved)) { res.status(404).end(); return; }

  res.sendFile(resolved);
});

export default router;
