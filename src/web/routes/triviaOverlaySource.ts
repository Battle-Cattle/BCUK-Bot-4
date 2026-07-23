import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import type { Response } from 'express';
import { TRIVIA_MAX_SSE_PER_CHANNEL } from '../../shared/config';
import { renderView } from './shared';
import { attachSseConnection, broadcastToChannel, createLoginValidator } from './sseChannel';
import { resolveTriviaGroup } from '../../trivia/triviaSessionGroup';
import { notifyConnectionCountChanged, type TriviaEvent } from '../../trivia/triviaGame';

const log = createLogger('TriviaOverlaySource');
const router = Router();

const LOGIN_RE = /^[a-zA-Z0-9_]{1,25}$/;
const isValidLogin = createLoginValidator(LOGIN_RE, new Set());

// In-memory map of active SSE connections keyed by Twitch channel login (lowercase) — each
// streamer opens their own `/trivia/<their-login>` OBS browser source.
export const connections = new Map<string, Set<Response>>();

export const MAX_SSE_CONNECTIONS_PER_CHANNEL = TRIVIA_MAX_SSE_PER_CHANNEL;

// Which logins currently belong to each trivia group key (a shared-chat session ID, or a
// channel's own login when playing solo), so a push targeting a group can fan out to every
// participating channel's connected overlay. Only grows with the number of distinct logins ever
// seen (bounded by the app's total managed channel count), so it's never cleared per-login —
// a stale entry left behind by a channel that stops connecting entirely is negligible.
const groupMembership = new Map<string, Set<string>>();
const loginGroupKey = new Map<string, string>();

const RECONCILE_INTERVAL_MS = 60_000;
let reconcileTimer: NodeJS.Timeout | null = null;

/** Sums connected overlay clients across every login currently mapped to `groupKey`. */
function totalConnectedInGroup(groupKey: string): number {
  const members = groupMembership.get(groupKey);
  if (!members) return 0;
  let total = 0;
  for (const login of members) total += connections.get(login)?.size ?? 0;
  return total;
}

/** Moves `login`'s group-membership bookkeeping to `groupKey`, removing it from any previous group. */
function setGroupMembership(login: string, groupKey: string): void {
  const previousKey = loginGroupKey.get(login);
  if (previousKey && previousKey !== groupKey) {
    groupMembership.get(previousKey)?.delete(login);
  }
  loginGroupKey.set(login, groupKey);
  if (!groupMembership.has(groupKey)) groupMembership.set(groupKey, new Set());
  groupMembership.get(groupKey)!.add(login);
}

/**
 * Re-resolves `login`'s current trivia group (including which other active channels share its
 * live shared-chat session, if any), updates the group-membership bookkeeping, and notifies the
 * game engine of both the new group's and (if it changed) the old group's current total
 * connected count.
 */
async function reconcileLogin(login: string): Promise<void> {
  const { groupKey, members } = await resolveTriviaGroup(login);
  const previousKey = loginGroupKey.get(login);

  setGroupMembership(login, groupKey);
  for (const member of members) {
    if (member !== login) setGroupMembership(member, groupKey);
  }

  notifyConnectionCountChanged(groupKey, totalConnectedInGroup(groupKey));
  if (previousKey && previousKey !== groupKey) {
    notifyConnectionCountChanged(previousKey, totalConnectedInGroup(previousKey));
  }
}

/**
 * Starts the periodic group-membership reconciliation tick if it isn't already running and at
 * least one overlay connection is open. Re-resolving only on connect/disconnect would miss a
 * shared-chat session starting or ending mid-stream for an OBS source that stays connected the
 * whole time, so this re-checks every currently-connected login on an interval instead. Stops
 * itself once every connection has closed.
 */
function ensureReconcileTimer(): void {
  if (reconcileTimer || connections.size === 0) return;
  reconcileTimer = setInterval(() => {
    if (connections.size === 0) {
      if (reconcileTimer) clearInterval(reconcileTimer);
      reconcileTimer = null;
      return;
    }
    for (const login of connections.keys()) {
      reconcileLogin(login).catch((err) => log.error(`Failed to reconcile trivia group for ${login}:`, err));
    }
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();
}

/** Pushes a trivia event to every login currently in `groupKey`'s trivia group with an active overlay connection. Registered with `triviaGame.registerTriviaPush`. */
export function pushTriviaEvent(groupKey: string, event: TriviaEvent): void {
  const members = groupMembership.get(groupKey);
  if (!members) return;
  for (const login of members) {
    broadcastToChannel(connections, login, event);
  }
}

/**
 * GET /trivia/:login — renders the trivia-overlay browser source HTML page for a Twitch channel
 * login (no auth, opened directly by OBS).
 * @param req - Express request; reads the `login` route param.
 * @param res - Express response; renders the `triviaOverlaySource` view, or calls `next()` to
 *   fall through to later routes if `login` is malformed.
 */
router.get('/:login', (req, res, next) => {
  const login = isValidLogin(req.params.login);
  if (login === null) { next(); return; }
  renderView(res, 'triviaOverlaySource', { login });
});

/**
 * GET /trivia/:login/events — SSE endpoint streaming trivia round events to a connected browser
 * source for a channel login (no auth, opened directly by OBS). Unlike the alerts/reward overlay
 * SSE routes, this one needs to react to connect/disconnect (to start/stop the shared trivia
 * round for the channel's group), so it calls `attachSseConnection` directly rather than the
 * plain `createSseEventsHandler` — its own JSDoc documents this as the intended escape hatch for
 * custom connection handling.
 * @param req - Express request; reads the `login` route param, and is listened to for `close` so
 *   the group's connection count (and, transitively, whether its round cycle keeps running) stays
 *   accurate after this client disconnects.
 * @param res - Express response; on a valid login, upgrades to a `text/event-stream` connection;
 *   replies 429 if the channel's connection limit is exceeded, or calls `next()` if `login` is malformed.
 */
router.get('/:login/events', (req, res, next) => {
  const key = isValidLogin(req.params.login);
  if (key === null) { next(); return; }

  const attached = attachSseConnection(req, res, {
    connections,
    key,
    maxPerChannel: MAX_SSE_CONNECTIONS_PER_CHANNEL,
  });
  if (!attached) return;

  ensureReconcileTimer();
  reconcileLogin(key).catch((err) => log.error(`Failed to resolve trivia group for ${key}:`, err));

  // Registered after attachSseConnection's own 'close' cleanup listener, so this one reads the
  // post-removal connection count.
  req.on('close', () => {
    reconcileLogin(key).catch((err) => log.error(`Failed to reconcile trivia group for ${key} on disconnect:`, err));
  });
});

export default router;
