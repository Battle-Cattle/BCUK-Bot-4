import type { Request, Response, NextFunction } from 'express';
import { SSE_MAX_TOTAL_CONNECTIONS } from '../../shared/config';

const KEEPALIVE_INTERVAL_MS = 25_000;

// Process-wide cap across every SSE endpoint (reward-video overlay, alerts overlay, companion
// app, channel-points prices), on top of each endpoint's own per-key `maxPerChannel` limit. Without
// this, an unauthenticated caller could exhaust sockets/timers/memory by opening connections under
// many distinct regex-valid-but-unregistered keys, each well under its own per-key cap.
let totalConnections = 0;

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
 * Shared by every SSE endpoint's push function (reward-video overlay, alerts overlay, companion
 * app, channel-points prices) so the broadcast-and-evict logic only needs to be gotten right in
 * one place.
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
  const dead: Response[] = [];
  for (const res of clients) {
    try {
      res.write(`data: ${serialized}\n\n`);
    } catch {
      dead.push(res);
    }
  }
  for (const res of dead) clients.delete(res);
  if (clients.size === 0) connections.delete(key);
  return clients.size;
}

/** Writes the SSE handshake headers and the initial `: connected` comment. */
function sendSseHandshake(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
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
  sendSseHandshake(res);

  let cleaned = false;
  // Idempotent: 'close' and 'error' can both fire for the same dead connection, and the keepalive
  // ping's own write failure also routes here — must only clear/evict (and release the global
  // slot) once.
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    totalConnections--;
    clearInterval(keepalive);
    removeClient(connections, key, res);
  };
  const keepalive = startKeepalive(res, cleanup);

  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
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
