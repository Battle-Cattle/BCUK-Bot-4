import { Router } from 'express';
import { requireOwner } from '../middleware';
import { onHealthChanged, getHealthSnapshot } from '../../shared/healthStore';
import { attachSseConnection, broadcastToChannel } from './sseChannel';
import { createLogger } from '../../shared/logger';

const log = createLogger('Web');
const router = Router();

/** Maximum concurrent SSE connections for the (single, ungoverned-by-guild) health stream. */
const MAX_HEALTH_SSE_CONNECTIONS = 10;

// A single global set of connections, keyed by a constant — health isn't per-guild like
// `dashboardStatusEvents.ts`'s status stream, so there's only ever one logical channel here.
const HEALTH_CHANNEL_KEY = 'health';
const connections = new Map<string, Set<import('express').Response>>();

/**
 * Pushes a fresh health snapshot to every connected owner health-dashboard client via
 * {@link broadcastToChannel}. Registered once as the `onHealthChanged` listener below, so it
 * fires after every `healthStore` mutation.
 */
function pushHealthUpdate(): void {
  try {
    broadcastToChannel(connections, HEALTH_CHANNEL_KEY, getHealthSnapshot());
  } catch (err) {
    log.error('Failed to push health update:', err);
  }
}

onHealthChanged(pushHealthUpdate);

/**
 * GET /admin/health/events — SSE endpoint streaming live `getHealthSnapshot()` updates for the
 * owner health dashboard. Owner-only; not guild-scoped.
 * @param req - Express request; listened to for the 'close' event by `attachSseConnection`.
 * @param res - Express response; upgraded to a `text/event-stream` connection.
 */
router.get('/events', requireOwner, (req, res) => {
  attachSseConnection(req, res, { connections, key: HEALTH_CHANNEL_KEY, maxPerChannel: MAX_HEALTH_SSE_CONNECTIONS });
});

export default router;
