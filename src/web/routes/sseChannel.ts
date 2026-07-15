import type { Request, Response, NextFunction } from 'express';

/** Options for {@link createSseEventsHandler}. */
export interface SseEventsHandlerOptions {
  /** In-memory map of active SSE connections keyed by lowercased channel login. */
  connections: Map<string, Set<Response>>;
  /** Validates the raw `:login` route param before it's used as a map key. */
  loginRe: RegExp;
  /** Reserved words that must not be treated as channel logins (e.g. `settings`). */
  reservedLogins: ReadonlySet<string>;
  /** Maximum concurrent SSE connections permitted per channel. */
  maxPerChannel: number;
}

/**
 * Builds a `/:login/events`-style SSE route handler, shared by the reward-video overlay and the
 * alerts overlay (each keeps its own `connections` map and push function, since those differ in
 * payload shape — this only factors out the identical connection lifecycle: login validation,
 * per-channel connection-limit enforcement, SSE handshake headers, the 25s keepalive ping, and
 * cleanup on a failed write or client disconnect).
 * @param options - See {@link SseEventsHandlerOptions}.
 * @returns An Express route handler: on a valid, non-reserved login, upgrades the response to
 *   `text/event-stream`; replies 429 if `maxPerChannel` is exceeded; calls `next()` if the login
 *   is malformed or reserved.
 */
export function createSseEventsHandler(
  options: SseEventsHandlerOptions,
): (req: Request<{ login: string }>, res: Response, next: NextFunction) => void {
  const { connections, loginRe, reservedLogins, maxPerChannel } = options;

  return (req, res, next) => {
    const { login } = req.params;
    if (!loginRe.test(login) || reservedLogins.has(login.toLowerCase())) { next(); return; }
    const key = login.toLowerCase();

    if (!connections.has(key)) connections.set(key, new Set());
    const clients = connections.get(key)!;
    clients.add(res);
    if (clients.size > maxPerChannel) {
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
        const clients = connections.get(key);
        if (clients) {
          clients.delete(res);
          if (clients.size === 0) connections.delete(key);
        }
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(keepalive);
      const clients = connections.get(key);
      if (!clients) return;
      clients.delete(res);
      if (clients.size === 0) connections.delete(key);
    });
  };
}
