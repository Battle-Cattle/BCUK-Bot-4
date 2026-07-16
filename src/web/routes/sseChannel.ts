import type { Request, Response, NextFunction } from 'express';

const KEEPALIVE_INTERVAL_MS = 25_000;

/** Removes `res` from the channel's client Set, deleting the map entry once it's empty. */
function removeClient<K>(connections: Map<K, Set<Response>>, key: K, res: Response): void {
  const clients = connections.get(key);
  if (!clients) return;
  clients.delete(res);
  if (clients.size === 0) connections.delete(key);
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
 * disconnected without the request's 'close' event firing first), evicts the client and clears
 * the interval so nothing is left running for a dead connection.
 * @returns The interval handle, so the caller can clear it on a normal 'close' event too.
 */
function startKeepalive<K>(connections: Map<K, Set<Response>>, key: K, res: Response): NodeJS.Timeout {
  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepalive);
      removeClient(connections, key, res);
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
 * @param req - Express request; used only to listen for the 'close' event.
 * @param res - Express response to register and stream to.
 * @param options - See {@link AttachSseConnectionOptions}.
 * @returns false if the key was already at `maxPerChannel` (a 429 has already been sent to `res`
 *   and the caller should stop handling the request); true once the connection is attached.
 */
export function attachSseConnection<K>(
  req: Request,
  res: Response,
  options: AttachSseConnectionOptions<K>,
): boolean {
  const { connections, key, maxPerChannel } = options;
  if (!connections.has(key)) connections.set(key, new Set());
  const clients = connections.get(key)!;
  clients.add(res);
  if (clients.size > maxPerChannel) {
    clients.delete(res);
    res.status(429).end();
    return false;
  }

  sendSseHandshake(res);
  const keepalive = startKeepalive(connections, key, res);

  req.on('close', () => {
    clearInterval(keepalive);
    removeClient(connections, key, res);
  });
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
