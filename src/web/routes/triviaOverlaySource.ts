import { Router } from 'express';
import type { Response } from 'express';
import { TRIVIA_MAX_SSE_PER_CHANNEL } from '../../shared/config';
import { normalizeDiscordId, renderView } from './shared';
import { attachSseConnection, broadcastToChannel, createLoginValidator } from './sseChannel';
import { setChannelGroupKey, clearChannelGroupKey } from '../../trivia/triviaChannelGroup';
import { notifyConnectionCountChanged, type TriviaEvent } from '../../trivia/triviaGame';

const router = Router();

const LOGIN_RE = /^[a-zA-Z0-9_]{1,25}$/;
// 'settings' is reserved for the /trivia/settings admin page (triviaAdmin.ts), mounted at the
// same '/trivia' prefix — without this it would be swallowed here as if it were a channel login.
const RESERVED_LOGINS = new Set(['settings']);
const isValidLogin = createLoginValidator(LOGIN_RE, RESERVED_LOGINS);

// In-memory map of active SSE connections keyed by Twitch channel login (lowercase) — each
// streamer opens their own `/trivia/<their-login>` OBS browser source. Used only for the
// per-channel connection cap; event fan-out is tracked separately (see `groupConnections` below).
export const connections = new Map<string, Set<Response>>();

export const MAX_SSE_CONNECTIONS_PER_CHANNEL = TRIVIA_MAX_SSE_PER_CHANNEL;

// Physical SSE connections grouped by trivia group key, tracked independently of `connections`
// (which is keyed by login). Two simultaneous connections for the same login opened under
// different `?guild=` params (e.g. a reconnect race, or the same URL opened twice) therefore never
// cross-talk: each connection is added to exactly the group it was configured for at connect time,
// and removed from that same group — never any other — on its own disconnect. Self-cleaning, like
// `connections`: a group's entry is deleted once its Set empties.
export const groupConnections = new Map<string, Set<Response>>();

/** Pushes a trivia event to every physical connection currently in `groupKey`'s trivia group. Registered with `triviaGame.registerTriviaPush`. */
export function pushTriviaEvent(groupKey: string, event: TriviaEvent): void {
  broadcastToChannel(groupConnections, groupKey, event);
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
 * SSE routes, this one needs to react to connect/disconnect (to record/refresh the channel's
 * trivia group and keep the shared round's connection count accurate), so it calls
 * `attachSseConnection` directly rather than the plain `createSseEventsHandler` — its own JSDoc
 * documents this as the intended escape hatch for custom connection handling.
 *
 * An optional `?guild=<discord guild id>` query param opts this channel into a shared round with
 * every other currently-connected channel using the same guild id — copied from the streamer's own
 * `/trivia/settings` page, not inferred from any roster/membership data, so a streamer decides
 * for themselves who they're playing with. Without it, the channel plays its own solo round.
 * @param req - Express request; reads the `login` route param and the `guild` query param, and is
 *   listened to for `close` so the group's connection count (and, transitively, whether its round
 *   cycle keeps running) stays accurate after this client disconnects.
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

  const requestedGuildId = typeof req.query.guild === 'string' ? normalizeDiscordId(req.query.guild) : null;
  const groupKey = requestedGuildId ?? key;

  setChannelGroupKey(key, groupKey);
  if (!groupConnections.has(groupKey)) groupConnections.set(groupKey, new Set());
  const groupSet = groupConnections.get(groupKey)!;
  groupSet.add(res);
  notifyConnectionCountChanged(groupKey, groupSet.size);

  // Registered after attachSseConnection's own 'close' cleanup listener, so `connections.get(key)`
  // below already reflects this connection's removal.
  req.on('close', () => {
    groupSet.delete(res);
    if (groupSet.size === 0) groupConnections.delete(groupKey);
    notifyConnectionCountChanged(groupKey, groupSet.size);
    if (!connections.has(key)) clearChannelGroupKey(key);
  });
});

export default router;
