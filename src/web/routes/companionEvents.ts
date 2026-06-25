import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { requireCompanionKey } from '../middleware';

const log = createLogger('CompanionEvents');
const router = Router();

/** A channel-point reward redemption forwarded to a user's companion app. */
export interface CompanionEvent {
  type: 'channel_points_redemption';
  rewardId: string;
  rewardTitle: string;
  userLogin: string;
  userName: string;
  userInput: string;
  redeemedAt: string;
}

// In-memory map of active SSE connections keyed by Discord ID.
export const connections = new Map<string, Set<import('express').Response>>();

const parsedMaxSse = parseInt(process.env.COMPANION_MAX_SSE_PER_TOKEN ?? '3', 10);
export const MAX_SSE_CONNECTIONS_PER_TOKEN =
  Number.isFinite(parsedMaxSse) && parsedMaxSse > 0 ? parsedMaxSse : 3;

/** Push a companion event to all of a Discord user's connected companion app instances. */
export function pushCompanionEvent(discordId: string, event: CompanionEvent): void {
  const clients = connections.get(discordId);
  if (!clients || clients.size === 0) return;
  const payload = JSON.stringify(event);
  const dead: import('express').Response[] = [];
  for (const res of clients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      dead.push(res);
    }
  }
  for (const res of dead) clients.delete(res);
  if (clients.size === 0) connections.delete(discordId);
  log.info(`Pushed companion event to ${clients.size} client(s) for discord ${discordId}`);
}

// GET /api/companion/events — SSE endpoint, bearer-token authenticated
router.get('/events', requireCompanionKey, (req, res) => {
  const discordId = req.companionDiscordId!;

  if (!connections.has(discordId)) connections.set(discordId, new Set());
  const clients = connections.get(discordId)!;
  clients.add(res);
  if (clients.size > MAX_SSE_CONNECTIONS_PER_TOKEN) {
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
      const clients = connections.get(discordId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) connections.delete(discordId);
      }
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepalive);
    const clients = connections.get(discordId);
    if (!clients) return;
    clients.delete(res);
    if (clients.size === 0) connections.delete(discordId);
  });
});

export default router;
