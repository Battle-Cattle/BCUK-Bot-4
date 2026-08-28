import type { Request, Response, NextFunction } from 'express';
import { SSE_MAX_TOTAL_CONNECTIONS } from '../../shared/config';
import { getStreamerByDiscordId, type DbStreamerEventSub } from '../../db';
import { getSessionUser } from '../session';
import type { createLogger } from '../../shared/logger';

const KEEPALIVE_INTERVAL_MS = 25_000;

// Process-wide cap across every SSE endpoint (reward-video overlay, alerts overlay, companion
// app, channel-points prices), on top of each endpoint's own per-key `maxPerChannel` limit. Without
// this, an unauthenticated caller could exhaust sockets/timers/memory by opening connections under
// many distinct regex-valid-but-unregistered keys, each well under its own per-key cap.
let totalConnections = 0;

/**
 * Maps a live SSE `Response` to its idempotent teardown (clears its keepalive interval, releases
 * its `totalConnections` slot, and evicts it from its connections map), registered once by
 * {@link attachSseConnection}. Consulted by {@link broadcastToChannel} so a failed broadcast
 * write releases the same resources a close/error event would, instead of only removing the
 * `Response` from its Set and leaving the interval/global slot to self-heal on the next ping.
 */
const connectionCleanups = new WeakMap<Response, () => void>();

/** Removes `res` from the channel's client Set, deleting the map entry once it's empty. */
function removeClient<K>(connections: Map<K, Set<Response>>, key: K, res: Response): void {
  const clients = connections.get(key);
  if (!clients) return;
  clients.delete(res);
  if (clients.size === 0) connections.delete(key);
}

/**
 * Serializes `payload` and writes it as an SSE `data:` frame to every client connected under
 * `key`, evicting any client whose write fails (and dropping the map entry if that empties it).
 * A failed client is torn down via its registered {@link attachSseConnection} cleanup when one
 * exists (clearing its keepalive interval and releasing its `totalConnections` slot immediately,
 * rather than leaving that to the next keepalive tick); falls back to removing it from the Set
 * directly for a client that was never registered that way. Shared by every SSE endpoint's push
 * function (reward-video overlay, alerts overlay, companion app, channel-points prices) so the
 * broadcast-and-evict logic only needs to be gotten right in one place.
 * @param connections - The channel's connections map.
 * @param key - Which key (channel login, Discord ID, streamer ID, etc) to broadcast to.
 * @param payload - The value to JSON-serialize and send as the event's data.
 * @returns The number of clients still connected under `key` after eviction, or null if there
 *   were no connections registered under `key` at all (nothing was sent).
 */
export function broadcastToChannel<K>(connections: Map<K, Set<Response>>, key: K, payload: unknown): number | null {
  const clients = connections.get(key);
  if (!clients || clients.size === 0) return null;
  const serialized = JSON.stringify(payload);
  for (const res of clients) {
    try {
      res.write(`data: ${serialized}\n\n`);
    } catch {
      const cleanup = connectionCleanups.get(res);
      if (cleanup) cleanup();
      else clients.delete(res);
    }
  }
  if (clients.size === 0) connections.delete(key);
  return clients.size;
}

/** Writes the SSE handshake headers and the initial `: connected` comment. */
function sendSseHandshake(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  // no-store (not the weaker no-cache) so no intermediary ever stores or replays a stream —
  // several of these carry per-streamer status that must not be cached or reused across clients.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering if behind proxy
  res.flushHeaders();
  res.write(': connected\n\n');
}

/**
 * Starts the periodic keepalive ping for one connection. If a ping write fails (e.g. the client
 * disconnected without any close/error event firing first), runs `cleanup` so nothing is left
 * running for a dead connection.
 * @param res - The SSE response to ping.
 * @param cleanup - Idempotent teardown (clears this interval and evicts the client) to run on a
 *   failed ping write.
 * @returns The interval handle, so the caller can also clear it on a normal close/error event.
 */
function startKeepalive(res: Response, cleanup: () => void): NodeJS.Timeout {
  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, KEEPALIVE_INTERVAL_MS);
  return keepalive;
}

/** Options for {@link attachSseConnection}. */
export interface AttachSseConnectionOptions<K> {
  /** In-memory map of active SSE connections keyed by `K` (a channel login, Discord ID, streamer ID, etc). */
  connections: Map<K, Set<Response>>;
  /** The already-resolved connection key for this request. */
  key: K;
  /** Maximum concurrent SSE connections permitted for this key. */
  maxPerChannel: number;
}

/**
 * Registers `res` as an SSE connection for `key`: enforces the per-key connection limit, sends
 * the SSE handshake, and wires up the keepalive ping plus cleanup on disconnect or a failed
 * write. This is the lower-level building block behind {@link createSseEventsHandler} — call it
 * directly when the connection key needs custom resolution (an authenticated Discord ID, a
 * streamer ID resolved via an async DB lookup, etc.) instead of a validated `:login` route param.
 * Shared by every SSE endpoint in the app (reward-video overlay, alerts overlay, companion app
 * events, channel-points price updates) so the connection lifecycle only needs to be
 * gotten right in one place.
 * @param req - Express request; listened to for the 'close' event (the normal disconnect path).
 * @param res - Express response to register and stream to; also listened to for 'close'/'error'
 *   (an abrupt socket failure can fire these without `req` ever emitting 'close').
 * @param options - See {@link AttachSseConnectionOptions}.
 * @returns false if the process-wide cap (`SSE_MAX_TOTAL_CONNECTIONS`) or the key was already at
 *   `maxPerChannel` (a 429 has already been sent to `res` and the caller should stop handling the
 *   request); true once the connection is attached.
 */
export function attachSseConnection<K>(
  req: Request,
  res: Response,
  options: AttachSseConnectionOptions<K>,
): boolean {
  const { connections, key, maxPerChannel } = options;
  if (totalConnections >= SSE_MAX_TOTAL_CONNECTIONS) {
    res.status(429).end();
    return false;
  }

  if (!connections.has(key)) connections.set(key, new Set());
  const clients = connections.get(key)!;
  clients.add(res);
  if (clients.size > maxPerChannel) {
    clients.delete(res);
    res.status(429).end();
    return false;
  }

  totalConnections++;

  let cleaned = false;
  let keepalive: NodeJS.Timeout | null = null;
  // Idempotent: 'close' and 'error' can both fire for the same dead connection, a failed
  // keepalive ping routes here too, and a failed broadcastToChannel write now also routes here —
  // must only clear/evict (and release the global slot) once. Registered (and wired up to
  // req/res events) BEFORE the handshake below so a throw from sendSseHandshake itself still
  // releases this connection's slot instead of leaking it forever — with nothing registered yet,
  // no close/error event would ever fire for it otherwise.
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    connectionCleanups.delete(res);
    totalConnections--;
    if (keepalive) clearInterval(keepalive);
    removeClient(connections, key, res);
  };
  connectionCleanups.set(res, cleanup);

  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  try {
    sendSseHandshake(res);
  } catch (err) {
    cleanup();
    throw err;
  }

  keepalive = startKeepalive(res, cleanup);
  return true;
}

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
}

/**
 * Builds a `/:login/events`-style SSE route handler, shared by the reward-video overlay and the
 * alerts overlay (each keeps its own `connections` map and push function, since those differ in
 * payload shape — this only factors out the identical connection lifecycle via
 * {@link attachSseConnection}).
 * @param options - See {@link SseEventsHandlerOptions}.
 * @returns An Express route handler: on a valid, non-reserved login, upgrades the response to
 *   `text/event-stream`; replies 429 if `maxPerChannel` is exceeded; calls `next()` if the login
 *   is malformed or reserved.
 */
export function createSseEventsHandler(
  options: SseEventsHandlerOptions,
): (req: Request<{ login: string }>, res: Response, next: NextFunction) => void {
  const { connections, isValidLogin, maxPerChannel } = options;

  return (req, res, next) => {
    const key = isValidLogin(req.params.login);
    if (key === null) { next(); return; }
    attachSseConnection(req, res, { connections, key, maxPerChannel });
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

    check();
    const interval = setInterval(check, pollIntervalMs);
    // attachSseConnection's own cleanup can be triggered by 'close'/'error' on either req or res
    // (an abrupt socket failure can fire res's events without req ever emitting 'close') — mirror
    // that here so this interval doesn't outlive the connection under those same paths.
    const clearStatusInterval = (): void => clearInterval(interval);
    req.on('close', clearStatusInterval);
    res.on('close', clearStatusInterval);
    res.on('error', clearStatusInterval);
  };
}
