import { describe, it, expect, afterEach } from 'vitest';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { trackForGracefulClose, type GracefulClose } from './serverDrain';
import { waitFor } from '../test-utils/waitFor';

let server: Server | undefined;
const agents: http.Agent[] = [];

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
  for (const agent of agents.splice(0)) agent.destroy();
});

/** Starts a server on a free loopback port with the given handler, tracked for a graceful close. */
async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; closeGracefully: GracefulClose; started: Set<string> }> {
  const started = new Set<string>();
  server = http.createServer((req, res) => {
    started.add(req.url ?? '');
    handler(req, res);
  });
  const closeGracefully = trackForGracefulClose(server);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, closeGracefully, started };
}

interface Reply { status?: number; body: string; error?: string }

/** Sends a GET on a keep-alive agent and resolves with the reply, or the error that cut it off. */
function get(port: number, path: string): Promise<Reply> {
  const agent = new http.Agent({ keepAlive: true });
  agents.push(agent);
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', (err) => resolve({ status: res.statusCode, body, error: err.message }));
      res.on('aborted', () => resolve({ status: res.statusCode, body, error: 'aborted' }));
    });
    req.on('error', (err) => resolve({ body: '', error: err.message }));
  });
}

describe('trackForGracefulClose', () => {
  it('lets a request still in progress finish with 200 before the close resolves', async () => {
    let finish: (() => void) | undefined;
    const { port, closeGracefully, started } = await startServer((_req, res) => {
      finish = () => res.end('done');
    });
    const reply = get(port, '/slow');
    await waitFor(() => expect(started.has('/slow')).toBe(true));

    let closeResolved = false;
    const closing = closeGracefully(5_000).then((timedOut) => { closeResolved = true; return timedOut; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closeResolved).toBe(false);
    expect(server!.listening).toBe(false);

    finish!();
    await expect(reply).resolves.toEqual({ status: 200, body: 'done' });
    // The keep-alive connection is closed once its request finishes, well before the 5s limit.
    await expect(closing).resolves.toBe(false);
  });

  it('cuts off a request still running at the time limit, and still resolves', async () => {
    const { port, closeGracefully, started } = await startServer(() => { /* never answers */ });
    const reply = get(port, '/stuck');
    await waitFor(() => expect(started.has('/stuck')).toBe(true));

    await expect(closeGracefully(50)).resolves.toBe(true);
    const result = await reply;
    expect(result.status).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  it('ends server-sent event streams straight away instead of waiting on them', async () => {
    const { port, closeGracefully, started } = await startServer((_req, res) => {
      // As sseChannel.ts does: setHeader, which getHeader can read back (writeHead's headers can't be).
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
      res.write(': connected\n\n');
    });
    const events = new Promise<void>((resolve) => {
      const agent = new http.Agent({ keepAlive: true });
      agents.push(agent);
      http.get({ host: '127.0.0.1', port, path: '/events', agent }, (res) => {
        res.on('close', () => resolve());
        res.resume();
      }).on('error', () => resolve());
    });
    await waitFor(() => expect(started.has('/events')).toBe(true));

    const startedAt = Date.now();
    await expect(closeGracefully(5_000)).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await events;
  });

  it('closes idle keep-alive connections without waiting for the time limit', async () => {
    const { port, closeGracefully } = await startServer((_req, res) => res.end('ok'));
    await expect(get(port, '/quick')).resolves.toEqual({ status: 200, body: 'ok' });

    const startedAt = Date.now();
    await expect(closeGracefully(5_000)).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('rejects when the server is not listening', async () => {
    server = http.createServer();
    const closeGracefully = trackForGracefulClose(server);
    await expect(closeGracefully(50)).rejects.toMatchObject({ code: 'ERR_SERVER_NOT_RUNNING' });
  });
});
