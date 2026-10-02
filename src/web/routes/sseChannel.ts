import type { Request, Response } from 'express';
import { SSE_MAX_TOTAL_CONNECTIONS } from '../../shared/config';
import { tryReservePoolSlot, releasePoolSlot, type SseConnectionPool } from './sseOverlayAccess';

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

/**
 * Adds `res` to `key`'s client Set unless that would exceed `maxPerChannel`.
 * @param connections - The endpoint's connections map.
 * @param key - The connection key.
 * @param res - The response to register.
 * @param maxPerChannel - Maximum concurrent connections for `key`.
 * @returns true if added; false (and nothing changed) if `key` was already at its limit.
 */
function addClientWithinLimit<K>(
  connections: Map<K, Set<Response>>, key: K, res: Response, maxPerChannel: number,
): boolean {
  const clients = connections.get(key) ?? new Set<Response>();
  if (clients.size >= maxPerChannel) return false;
  clients.add(res);
  connections.set(key, clients);
  return true;
}

/**
 * Reserves a slot under the process-wide cap and, when given, the unauthenticated `pool`, then
 * runs `addClient` for the per-key limit. All-or-nothing: if any limit is already reached, every
 * slot reserved so far is released again.
 * @param req - Express request; its client IP keys the pool's per-IP limit.
 * @param pool - Optional unauthenticated sub-pool (see `SseConnectionPool`).
 * @param addClient - Registers the client under its key; returns false if the per-key limit is reached.
 * @returns A function that releases the pool slot (a no-op without a pool), or null if a limit
 *   was reached and nothing was reserved.
 */
function reserveConnectionSlots(
  req: Request, pool: SseConnectionPool | undefined, addClient: () => boolean,
): (() => void) | null {
  if (totalConnections >= SSE_MAX_TOTAL_CONNECTIONS) return null;
  const poolIp = pool ? tryReservePoolSlot(pool, req) : '';
  if (poolIp === null) return null;
  const releasePool = (): void => { if (pool) releasePoolSlot(pool, poolIp); };
  if (!addClient()) {
    releasePool();
    return null;
  }
  totalConnections++;
  return releasePool;
}

/** Options for {@link attachSseConnection}. */
export interface AttachSseConnectionOptions<K> {
  /** In-memory map of active SSE connections keyed by `K` (a channel login, Discord ID, streamer ID, etc). */
  connections: Map<K, Set<Response>>;
  /** The already-resolved connection key for this request. */
  key: K;
  /** Maximum concurrent SSE connections permitted for this key. */
  maxPerChannel: number;
  /**
   * Optional sub-pool (see {@link SseConnectionPool}) whose total and per-IP limits also apply,
   * for endpoints reachable without authentication. Omit for authenticated streams.
   */
  pool?: SseConnectionPool;
}

/**
 * Registers `res` as an SSE connection for `key`: enforces the per-key connection limit, sends
 * the SSE handshake, and wires up the keepalive ping plus cleanup on disconnect or a failed
 * write. This is the lower-level building block behind `createSseEventsHandler` (sseEventsHandlers.ts) — call it
 * directly when the connection key needs custom resolution (an authenticated Discord ID, a
 * streamer ID resolved via an async DB lookup, etc.) instead of a validated `:login` route param.
 * Shared by every SSE endpoint in the app (reward-video overlay, alerts overlay, companion app
 * events, channel-points price updates) so the connection lifecycle only needs to be
 * gotten right in one place.
 * @param req - Express request; listened to for the 'close' event (the normal disconnect path).
 * @param res - Express response to register and stream to; also listened to for 'close'/'error'
 *   (an abrupt socket failure can fire these without `req` ever emitting 'close').
 * @param options - See {@link AttachSseConnectionOptions}.
 * @returns false if the process-wide cap (`SSE_MAX_TOTAL_CONNECTIONS`), the `pool`'s total or
 *   per-IP limit, or the key's `maxPerChannel` was already reached (a 429 has already been sent to
 *   `res` and the caller should stop handling the request); true once the connection is attached.
 */
export function attachSseConnection<K>(
  req: Request,
  res: Response,
  options: AttachSseConnectionOptions<K>,
): boolean {
  const { connections, key, maxPerChannel, pool } = options;
  const releasePool = reserveConnectionSlots(req, pool, () => addClientWithinLimit(connections, key, res, maxPerChannel));
  if (!releasePool) {
    res.status(429).end();
    return false;
  }

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
    releasePool();
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
 * Extends the teardown {@link attachSseConnection} registered for `res` so it also runs `extra`,
 * covering every path that ends the connection, including a failed {@link broadcastToChannel}
 * write that emits no close/error event.
 * @param res - A response previously attached with {@link attachSseConnection}.
 * @param extra - Additional teardown to run once the connection's own cleanup has run.
 * @returns false if `res` has no registered cleanup (its connection was already torn down), in
 *   which case nothing was chained and the caller should tear down `extra`'s resources itself.
 */
export function chainConnectionCleanup(res: Response, extra: () => void): boolean {
  const cleanup = connectionCleanups.get(res);
  if (!cleanup) return false;
  connectionCleanups.set(res, () => {
    cleanup();
    extra();
  });
  return true;
}
