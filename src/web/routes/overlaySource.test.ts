import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

/** Mocks the shared logger so route handlers don't write real log output during tests. */
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../shared/config', () => ({
  OVERLAY_FOLDER: '/app/overlay-videos',
  OVERLAY_MAX_SSE_PER_CHANNEL: 10,
}));

vi.mock('fs', () => ({
  default: {
    promises: { access: vi.fn() },
    readdirSync: () => ['controllerOverlay.ejs', 'overlaySource.ejs'],
  },
}));

vi.mock('../../shared/pathUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/pathUtils')>();
  return { safeResolve: vi.fn(actual.safeResolve) };
});

import fs from 'fs';
import express from 'express';
import supertest from 'supertest';
import router, { MAX_SSE_CONNECTIONS_PER_CHANNEL, connections, pushOverlayEvent } from './overlaySource';
import { safeResolve } from '../../shared/pathUtils';

/** Finds a route's handler function directly from the router's internal stack, bypassing HTTP entirely — needed to control fake timers and the request's 'close' event deterministically. */
function getRouteHandler(routePath: string): (req: any, res: any, next: any) => void {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath);
  return layer.route.stack[0].handle;
}

function makeSseRes() {
  return {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    status: vi.fn().mockReturnThis(),
    end: vi.fn(),
    on: vi.fn(),
  };
}

function makeSseReq(login: string) {
  let closeCb: (() => void) | undefined;
  return {
    req: {
      params: { login },
      on: (event: string, cb: () => void) => {
        if (event === 'close') closeCb = cb;
      },
    },
    triggerClose: () => closeCb?.(),
  };
}

function buildApp() {
  const app = express();
  // Capture res.render calls as JSON so tests don't need a real view engine.
  app.use((req, res, next) => {
    (res as any).render = (view: string, locals?: Record<string, unknown>) =>
      res.json({ view, ...(locals ?? {}) });
    (res as any).sendFile = (filePath: string) => res.json({ sentFile: filePath });
    next();
  });
  app.use(router);
  return app;
}

beforeEach(() => {
  connections.clear();
  vi.clearAllMocks();
});

describe('GET /controller', () => {
  it('returns 200 and renders the controllerOverlay view', async () => {
    const res = await supertest(buildApp()).get('/controller');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('controllerOverlay');
  });

  it('is not caught by the :login route — "controller" is in RESERVED_LOGINS', async () => {
    // /:login renders 'overlaySource'; /controller must render 'controllerOverlay'.
    const res = await supertest(buildApp()).get('/controller');
    expect(res.body.view).toBe('controllerOverlay');
    expect(res.body.view).not.toBe('overlaySource');
  });
});

describe('GET /:login', () => {
  it('renders the overlaySource view with the lowercased login', async () => {
    const res = await supertest(buildApp()).get('/SomeChannel');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('overlaySource');
    expect(res.body.login).toBe('somechannel');
  });

  it('falls through (404) for a reserved login', async () => {
    const res = await supertest(buildApp()).get('/settings');
    expect(res.status).toBe(404);
  });

  it('falls through (404) for a malformed login', async () => {
    const res = await supertest(buildApp()).get('/not-valid!');
    expect(res.status).toBe(404);
  });
});

describe('MAX_SSE_CONNECTIONS_PER_CHANNEL', () => {
  it('re-exports the value from config', () => {
    expect(MAX_SSE_CONNECTIONS_PER_CHANNEL).toBe(10);
  });
});

describe('GET /:login/events — SSE connection limit', () => {
  it('returns 429 when the per-channel slot is full', async () => {
    // Pre-fill the channel with dummy response objects to simulate MAX connections
    const dummies = new Set(
      Array.from({ length: MAX_SSE_CONNECTIONS_PER_CHANNEL }, () => ({}) as any),
    );
    connections.set('testchannel', dummies);

    const res = await supertest(buildApp()).get('/testchannel/events');
    expect(res.status).toBe(429);
  });

  it('accepts a connection when the channel is below the limit', async () => {
    // One fewer than the limit — should not be rejected
    const dummies = new Set(
      Array.from({ length: MAX_SSE_CONNECTIONS_PER_CHANNEL - 1 }, () => ({}) as any),
    );
    connections.set('testchannel', dummies);

    // SSE responses never complete; timeout at transport level means we just
    // verify status is not 429 (headers arrive before the body stalls).
    const req = supertest(buildApp()).get('/testchannel/events');
    const p = new Promise<number>((resolve) => {
      req
        .buffer(false)
        .parse((_res, _cb) => {
          resolve(_res.statusCode ?? 0);
          (_res as any).resume();
        })
        .end();
    });
    const status = await p;
    expect(status).not.toBe(429);
    expect(status).toBe(200);
  });

  it('falls through (404) for a reserved login', async () => {
    const res = await supertest(buildApp()).get('/settings/events');
    expect(res.status).toBe(404);
  });

  it('falls through (404) for a malformed login', async () => {
    const res = await supertest(buildApp()).get('/not-valid!/events');
    expect(res.status).toBe(404);
  });
});

describe('GET /:login/events — connection lifecycle (direct handler invocation)', () => {
  it('registers a new Set for a channel with no prior connections', () => {
    const handler = getRouteHandler('/:login/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('freshchannel');

    handler(req, res, vi.fn());

    expect(connections.get('freshchannel')?.has(res as any)).toBe(true);
    expect(res.write).toHaveBeenCalledWith(': connected\n\n');

    triggerClose(); // clears the 25s keepalive interval so it doesn't leak into other tests
  });

  it('sends a ping every 25 seconds', () => {
    vi.useFakeTimers();
    try {
      const handler = getRouteHandler('/:login/events');
      const res = makeSseRes();
      const { req, triggerClose } = makeSseReq('pingchannel');

      handler(req, res, vi.fn());
      res.write.mockClear();

      vi.advanceTimersByTime(25_000);
      expect(res.write).toHaveBeenCalledWith(': ping\n\n');
      triggerClose(); // clears the keepalive interval before switching timer modes
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the interval and evicts the client when a ping write fails', () => {
    vi.useFakeTimers();
    try {
      const handler = getRouteHandler('/:login/events');
      const res = makeSseRes();
      const { req } = makeSseReq('brokenpipe');

      handler(req, res, vi.fn());
      res.write.mockImplementation(() => {
        throw new Error('broken pipe');
      });

      vi.advanceTimersByTime(25_000);

      // Only client for this channel — eviction empties the Set, which deletes the map entry
      // and clears the interval, so there's nothing left to close.
      expect(connections.get('brokenpipe')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not throw on a failed ping when the channel entry is already gone', () => {
    vi.useFakeTimers();
    try {
      const handler = getRouteHandler('/:login/events');
      const res = makeSseRes();
      const { req } = makeSseReq('alreadygone');

      handler(req, res, vi.fn());
      connections.delete('alreadygone');

      res.write.mockImplementation(() => {
        throw new Error('broken pipe');
      });

      // The failed write's catch block clears the interval unconditionally, so there's
      // no leaked interval here even though the channel entry was removed beforehand.
      expect(() => vi.advanceTimersByTime(25_000)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes the client (and empty Set) when the request closes', () => {
    const handler = getRouteHandler('/:login/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('closingchannel');

    handler(req, res, vi.fn());
    expect(connections.get('closingchannel')?.has(res as any)).toBe(true);

    triggerClose();
    expect(connections.get('closingchannel')).toBeUndefined();
  });

  it('removes only the closing client, keeping the channel entry when others remain', () => {
    const handler = getRouteHandler('/:login/events');
    const res1 = makeSseRes();
    const res2 = makeSseRes();
    const { req: req1, triggerClose: closeReq1 } = makeSseReq('sharedchannel');
    const { req: req2 } = makeSseReq('sharedchannel');

    handler(req1, res1, vi.fn());
    handler(req2, res2, vi.fn());

    closeReq1();
    expect(connections.get('sharedchannel')?.has(res1 as any)).toBe(false);
    expect(connections.get('sharedchannel')?.has(res2 as any)).toBe(true);
  });
});

describe('pushOverlayEvent', () => {
  it('does nothing when there are no connections for the channel', () => {
    expect(() => pushOverlayEvent('nobody', '/video.mp4')).not.toThrow();
  });

  it('writes the video payload to every connected client', () => {
    const res1 = { write: vi.fn() };
    const res2 = { write: vi.fn() };
    connections.set('livechannel', new Set([res1, res2] as any));

    pushOverlayEvent('LiveChannel', '/videos/1/clip.mp4');

    const expectedPayload = `data: ${JSON.stringify({ video: '/videos/1/clip.mp4' })}\n\n`;
    expect(res1.write).toHaveBeenCalledWith(expectedPayload);
    expect(res2.write).toHaveBeenCalledWith(expectedPayload);
  });

  it('drops a client whose write throws but keeps the others', () => {
    const good = { write: vi.fn() };
    const dead = { write: vi.fn(() => { throw new Error('broken pipe'); }) };
    connections.set('mixedchannel', new Set([good, dead] as any));

    pushOverlayEvent('mixedchannel', '/video.mp4');

    const clients = connections.get('mixedchannel');
    expect(clients?.has(good as any)).toBe(true);
    expect(clients?.has(dead as any)).toBe(false);
  });

  it('deletes the map entry once every client has been dropped', () => {
    const dead = { write: vi.fn(() => { throw new Error('broken pipe'); }) };
    connections.set('emptiedchannel', new Set([dead] as any));

    pushOverlayEvent('emptiedchannel', '/video.mp4');

    expect(connections.has('emptiedchannel')).toBe(false);
  });
});

describe('GET /videos/:streamerId/:filename', () => {
  beforeEach(() => {
    vi.mocked(safeResolve).mockClear();
  });

  it('returns 400 for a non-numeric streamerId', async () => {
    const res = await supertest(buildApp()).get('/videos/abc/clip.mp4');
    expect(res.status).toBe(400);
  });

  it('returns 400 for a malformed filename', async () => {
    const res = await supertest(buildApp()).get('/videos/123/cl%20ip.mp4');
    expect(res.status).toBe(400);
  });

  it('returns 400 for a filename with a disallowed extension', async () => {
    const res = await supertest(buildApp()).get('/videos/123/clip.exe');
    expect(res.status).toBe(400);
  });

  it('returns 400 when safeResolve rejects the path as unsafe', async () => {
    vi.mocked(safeResolve).mockReturnValueOnce(null);
    const res = await supertest(buildApp()).get('/videos/123/clip.mp4');
    expect(res.status).toBe(400);
  });

  it('returns 404 when the file does not exist on disk', async () => {
    vi.mocked(fs.promises.access).mockRejectedValueOnce(new Error('ENOENT'));
    const res = await supertest(buildApp()).get('/videos/123/clip.mp4');
    expect(res.status).toBe(404);
  });

  it('sends the resolved file when it exists', async () => {
    vi.mocked(fs.promises.access).mockResolvedValueOnce(undefined);
    const res = await supertest(buildApp()).get('/videos/123/clip.mp4');
    expect(res.status).toBe(200);
    expect(res.body.sentFile).toBe('/app/overlay-videos/123/clip.mp4');
  });
});
