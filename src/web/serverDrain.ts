import type { Server, ServerResponse } from 'node:http';

/**
 * Closes a server gracefully: stops accepting connections, waits for in-flight requests to finish
 * (up to a time limit), then drops whatever is left.
 * @param timeoutMs - How long to wait for in-flight requests before cutting them off.
 * @returns Resolves once the server has closed: false when every connection finished in time, true
 *   when the time limit was reached and the connections still open were dropped. Rejects with the error
 *   `server.close()` reports (`ERR_SERVER_NOT_RUNNING` if it wasn't listening).
 */
export type GracefulClose = (timeoutMs: number) => Promise<boolean>;

/**
 * Whether a response is a server-sent event stream. Those never finish on their own, so a drain
 * that waited on them would always run to its time limit.
 * @param res - The response to check.
 * @returns true once the response has been given a `text/event-stream` content type.
 */
function isEventStream(res: ServerResponse): boolean {
  const contentType = res.getHeader('content-type');
  return typeof contentType === 'string' && contentType.startsWith('text/event-stream');
}

/**
 * Starts tracking `server`'s open responses and returns the function that closes it gracefully.
 * Call it before the server takes its first request, so every response is tracked.
 *
 * The close runs in two phases:
 * 1. `server.close()` stops new connections, every server-sent event stream is ended (they never
 *    finish by themselves; the overlays' and dashboards' `EventSource`s reconnect to the next
 *    process), and idle keep-alive connections are closed. Each request still running is left to
 *    finish, and its connection is closed as soon as it does.
 * 2. If requests are still running after `timeoutMs`, `server.closeAllConnections()` drops them.
 *
 * @param server - The HTTP server to track; it should not be listening yet.
 * @returns The graceful close function for this server.
 */
export function trackForGracefulClose(server: Server): GracefulClose {
  const openResponses = new Set<ServerResponse>();
  let draining = false;

  server.on('request', (_req, res: ServerResponse) => {
    openResponses.add(res);
    res.once('close', () => {
      openResponses.delete(res);
      // Once a draining request finishes its connection goes back to idle; close it then, on the
      // next turn of the event loop, after Node has marked it idle. Otherwise a keep-alive client
      // would hold the server open until the time limit.
      if (draining) setImmediate(() => server.closeIdleConnections());
    });
  });

  return async (timeoutMs) => {
    draining = true;
    const closed = new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    for (const res of openResponses) {
      if (isEventStream(res)) res.destroy();
    }
    server.closeIdleConnections();

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); });
    try {
      if (await Promise.race([closed.then(() => false), timedOut])) {
        server.closeAllConnections();
        await closed;
        return true;
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
