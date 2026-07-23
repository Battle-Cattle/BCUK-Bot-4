import { Router } from 'express';
import type { Response } from 'express';
import { TRIVIA_MAX_SSE_PER_CHANNEL } from '../../shared/config';
import { normalizeDiscordId, renderView } from './shared';
import { attachSseConnection, broadcastToChannel, createLoginValidator } from './sseChannel';
import { setChannelGroupKey, getChannelsInGroup } from '../../trivia/triviaChannelGroup';
import { notifyConnectionCountChanged, type TriviaEvent } from '../../trivia/triviaGame';

const router = Router();

const LOGIN_RE = /^[a-zA-Z0-9_]{1,25}$/;
const isValidLogin = createLoginValidator(LOGIN_RE, new Set());

// In-memory map of active SSE connections keyed by Twitch channel login (lowercase) — each
// streamer opens their own `/trivia/<their-login>` OBS browser source.
export const connections = new Map<string, Set<Response>>();

export const MAX_SSE_CONNECTIONS_PER_CHANNEL = TRIVIA_MAX_SSE_PER_CHANNEL;

/** Sums connected overlay clients across every login currently in `groupKey`'s trivia group. */
function totalConnectedInGroup(groupKey: string): number {
  let total = 0;
  for (const login of getChannelsInGroup(groupKey)) total += connections.get(login)?.size ?? 0;
  return total;
}

/** Pushes a trivia event to every login currently in `groupKey`'s trivia group with an active overlay connection. Registered with `triviaGame.registerTriviaPush`. */
export function pushTriviaEvent(groupKey: string, event: TriviaEvent): void {
  for (const login of getChannelsInGroup(groupKey)) {
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
 * SSE routes, this one needs to react to connect/disconnect (to record/refresh the channel's
 * trivia group and keep the shared round's connection count accurate), so it calls
 * `attachSseConnection` directly rather than the plain `createSseEventsHandler` — its own JSDoc
 * documents this as the intended escape hatch for custom connection handling.
 *
 * An optional `?guild=<discord guild id>` query param opts this channel into a shared round with
 * every other currently-connected channel using the same guild id — copied from the guild's
 * `/streams` dashboard page, not inferred from any roster/membership data, so a streamer decides
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
  notifyConnectionCountChanged(groupKey, totalConnectedInGroup(groupKey));

  // Registered after attachSseConnection's own 'close' cleanup listener, so this one reads the
  // post-removal connection count.
  req.on('close', () => {
    notifyConnectionCountChanged(groupKey, totalConnectedInGroup(groupKey));
  });
});

export default router;
