import type { Request, Response, NextFunction } from 'express';
import { getStreamerByDiscordId, type DbStreamerEventSub } from '../../db';
import { getSessionUser } from '../session';
import { isKnownStreamerLogin, unauthenticatedOverlayPool, type SseConnectionPool } from './sseOverlayAccess';
import { attachSseConnection, broadcastToChannel, chainConnectionCleanup } from './sseChannel';
import type { createLogger } from '../../shared/logger';

// Express route-handler factories for the app's SSE endpoints, built on attachSseConnection
// (sseChannel.ts): the public `/:login/events` overlay streams, the session-scoped streamer
// streams, and the overlay-status stream.

/**
 * Builds a validator for a `:login` route param: rejects logins that fail `loginRe` or match a
 * reserved word, otherwise normalizes to lowercase. Shared by a channel's plain browser-source
 * route and its `/events` SSE route so both apply the identical rule from one place.
 * @param loginRe - Allowed-character/length pattern for a raw login.
 * @param reservedLogins - Words that must not be treated as channel logins (e.g. `settings`).
 * @returns A function returning the normalized (lowercased) login, or null if invalid/reserved.
 */
export function createLoginValidator(
  loginRe: RegExp,
  reservedLogins: ReadonlySet<string>,
): (login: string) => string | null {
  return (login: string) => {
    if (!loginRe.test(login) || reservedLogins.has(login.toLowerCase())) return null;
    return login.toLowerCase();
  };
}

/** Options for {@link createSseEventsHandler}. */
export interface SseEventsHandlerOptions {
  /** In-memory map of active SSE connections keyed by lowercased channel login. */
  connections: Map<string, Set<Response>>;
  /** Validates and normalizes the raw `:login` route param — see {@link createLoginValidator}. */
  isValidLogin: (login: string) => string | null;
  /** Maximum concurrent SSE connections permitted per channel. */
  maxPerChannel: number;
  /** Whether a normalized login belongs to a registered streamer. Defaults to {@link isKnownStreamerLogin}. */
  isKnownLogin?: (login: string) => Promise<boolean>;
  /** Unauthenticated sub-pool these connections count against. Defaults to {@link unauthenticatedOverlayPool}. */
  pool?: SseConnectionPool;
}

/**
 * Builds a `/:login/events`-style SSE route handler, shared by the reward-video overlay and the
 * alerts overlay (each keeps its own `connections` map and push function, since those differ in
 * payload shape — this only factors out the identical connection lifecycle via
 * {@link attachSseConnection}). These endpoints are opened unauthenticated by OBS, so a login
 * must belong to a registered streamer, and every connection counts against the shared
 * unauthenticated `pool` (total and per-IP limits) rather than only the process-wide cap.
 * @param options - See {@link SseEventsHandlerOptions}.
 * @returns An Express route handler: on a valid, non-reserved login of a registered streamer,
 *   upgrades the response to `text/event-stream`; replies 404 for a well-formed login that isn't a
 *   registered streamer, 503 if that lookup fails, 429 if `maxPerChannel` or a pool limit is
 *   exceeded; calls `next()` if the login is malformed or reserved.
 */
export function createSseEventsHandler(
  options: SseEventsHandlerOptions,
): (req: Request<{ login: string }>, res: Response, next: NextFunction) => Promise<void> {
  const {
    connections, isValidLogin, maxPerChannel,
    isKnownLogin = isKnownStreamerLogin,
    pool = unauthenticatedOverlayPool,
  } = options;

  return async (req, res, next) => {
    const key = isValidLogin(req.params.login);
    if (key === null) { next(); return; }
    let known: boolean;
    try {
      known = await isKnownLogin(key);
    } catch {
      res.status(503).end();
      return;
    }
    if (!known) {
      res.status(404).end();
      return;
    }
    // attachSseConnection skips a client that went away while the lookup above was awaited (a
    // cold cache load hits the DB).
    attachSseConnection(req, res, { connections, key, maxPerChannel, pool });
  };
}

/** Options for {@link createStreamerSseEventsHandler}. */
export interface StreamerSseEventsHandlerOptions<K> {
  /** In-memory map of active SSE connections keyed by `K` (a streamer ID, Twitch login, etc). */
  connections: Map<K, Set<Response>>;
  /** Maximum concurrent SSE connections permitted per key. */
  maxPerChannel: number;
  /** Derives the connection key from the resolved streamer row (e.g. `streamer.id`). */
  resolveKey: (streamer: DbStreamerEventSub) => K;
  /** Logger used to report an unexpected streamer lookup failure. */
  log: ReturnType<typeof createLogger>;
}

/**
 * Builds a `/events`-style SSE route handler for the logged-in session user's own streamer
 * row: resolves it via `getStreamerByDiscordId`, replies 403 if they aren't a monitored
 * streamer, 500 (logged) if the lookup itself fails, otherwise delegates to
 * {@link attachSseConnection}. Shared by every per-streamer SSE endpoint (channel-points
 * pricing, dashboard events/status) — each keeps its own `connections` map and payload shape,
 * since those differ, but the "resolve the session's streamer" lifecycle around them is
 * identical. The streamer is re-resolved on every connection attempt (rather than trusting a
 * cached id) so a revoked streamer record takes effect immediately.
 * @param options - See {@link StreamerSseEventsHandlerOptions}.
 * @returns An Express route handler for the logged-in user's own streamer SSE stream.
 */
export function createStreamerSseEventsHandler<K>(
  options: StreamerSseEventsHandlerOptions<K>,
): (req: Request, res: Response) => Promise<void> {
  const { connections, maxPerChannel, resolveKey, log } = options;

  return async (req, res) => {
    let streamer: DbStreamerEventSub | null;
    try {
      streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
    } catch (err) {
      log.error('Failed to resolve streamer for SSE events:', err);
      res.status(500).end();
      return;
    }
    if (!streamer) {
      res.status(403).end();
      return;
    }

    attachSseConnection(req, res, { connections, key: resolveKey(streamer), maxPerChannel });
  };
}

/** Options for {@link createOverlayStatusEventsHandler}. */
export interface OverlayStatusEventsHandlerOptions {
  /** In-memory map of active status-stream SSE connections, keyed by streamer ID. */
  statusConnections: Map<number, Set<Response>>;
  /** The overlay's own connections map (e.g. from `overlaySource.ts`/`alertsOverlaySource.ts`), keyed by lowercased Twitch login — polled to derive `connected`. */
  overlayConnections: Map<string, Set<Response>>;
  /** Maximum concurrent status-stream connections permitted per streamer. */
  maxPerChannel: number;
  /** How often (ms) to re-check `overlayConnections` for a state change. */
  pollIntervalMs: number;
  /** Logger used to report an unexpected streamer lookup failure. */
  log: ReturnType<typeof createLogger>;
}

/**
 * Builds a `/settings/events`-style SSE route handler streaming `{ connected: boolean }`
 * snapshots of whether the logged-in user's own browser-source overlay currently has an open
 * connection, so a settings page can show a live status dot instead of the user only finding out
 * something's wrong when an overlay never fires. Shared by the reward-video and alerts overlay
 * settings pages (`overlayAdmin.ts`/`alertsAdmin.ts`) — each keeps its own `statusConnections` and
 * `overlayConnections` maps, since those differ, but the "resolve the session's streamer, then
 * poll for a connection-count change" lifecycle is identical. Polls on an interval rather than
 * reacting to a push event, since opening/closing an overlay's own SSE connection has no existing
 * event to subscribe to.
 * @param options - See {@link OverlayStatusEventsHandlerOptions}.
 * @returns An Express route handler: replies 403 if the user isn't a monitored streamer with a
 *   linked Twitch channel, 500 (logged) if the streamer lookup fails, 429 if `maxPerChannel` is
 *   exceeded, otherwise upgrades to `text/event-stream` and tears down the poll interval (along
 *   with the connection itself) on client disconnect.
 */
export function createOverlayStatusEventsHandler(
  options: OverlayStatusEventsHandlerOptions,
): (req: Request, res: Response) => Promise<void> {
  const { statusConnections, overlayConnections, maxPerChannel, pollIntervalMs, log } = options;

  /**
   * Route handler for one settings page's status stream: resolves the session's streamer, attaches
   * the SSE connection, then polls `overlayConnections` for that streamer's login on an interval.
   * @param req - Express request; reads `req.session.user`.
   * @param res - Express response; see {@link createOverlayStatusEventsHandler}'s `@returns`.
   */
  return async (req, res) => {
    let streamer: DbStreamerEventSub | null;
    try {
      streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
    } catch (err) {
      log.error('Failed to resolve streamer for overlay status SSE:', err);
      res.status(500).end();
      return;
    }
    if (!streamer || !streamer.twitch_name) {
      res.status(403).end();
      return;
    }

    const attached = attachSseConnection(req, res, {
      connections: statusConnections,
      key: streamer.id,
      maxPerChannel,
    });
    if (!attached) return;

    const streamerId = streamer.id;
    const login = streamer.twitch_name.toLowerCase();
    let lastConnected: boolean | null = null;

    /** Re-checks whether `login`'s overlay has any open connection, broadcasting only on a change. */
    const check = (): void => {
      const isConnected = (overlayConnections.get(login)?.size ?? 0) > 0;
      if (isConnected === lastConnected) return;
      lastConnected = isConnected;
      broadcastToChannel(statusConnections, streamerId, { connected: isConnected });
    };

    const interval = setInterval(check, pollIntervalMs);
    // attachSseConnection's own cleanup can be triggered by 'close'/'error' on either req or res
    // (an abrupt socket failure can fire res's events without req ever emitting 'close') — mirror
    // that here so this interval doesn't outlive the connection under those same paths.
    /** Idempotent teardown for this handler's poll interval, wired to every path that can end the connection below. */
    const clearStatusInterval = (): void => clearInterval(interval);
    req.on('close', clearStatusInterval);
    res.on('close', clearStatusInterval);
    res.on('error', clearStatusInterval);

    // A failed res.write() inside broadcastToChannel's own `check()` call evicts this response via
    // the same connectionCleanups entry attachSseConnection just registered for it — without
    // emitting 'close'/'error' on either req or res, so the listeners above never fire for that
    // path. Wrap that cleanup so it also stops this interval; this must happen BEFORE the first
    // check() below runs, otherwise a failure on that very first write would find no cleanup
    // entry left to wrap (attachSseConnection's own cleanup already deleted it) and leak the
    // interval with nothing left to own its teardown.
    if (!chainConnectionCleanup(res, clearStatusInterval)) {
      // attachSseConnection's connection was already torn down before we got here — nothing left
      // to poll for.
      clearInterval(interval);
      return;
    }

    check();
  };
}
