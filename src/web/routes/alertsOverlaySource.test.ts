import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

/** Mocks the shared logger so route handlers don't write real log output during tests. */
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../shared/config', () => ({
  ALERT_ASSETS_FOLDER: '/app/alert-assets',
  ALERT_MAX_SSE_PER_CHANNEL: 10,
  SSE_MAX_TOTAL_CONNECTIONS: 1000,
}));

vi.mock('fs', () => ({
  default: {
    promises: { access: vi.fn() },
    readdirSync: () => ['alertsOverlaySource.ejs'],
  },
}));

vi.mock('../../shared/pathUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/pathUtils')>();
  return { safeResolve: vi.fn(actual.safeResolve) };
});

import fs from 'fs';
import express from 'express';
import supertest from 'supertest';
import router, { MAX_SSE_CONNECTIONS_PER_CHANNEL, connections, pushAlertEvent } from './alertsOverlaySource';
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
    next();
  });
  app.use(router);
  return app;
}

beforeEach(() => {
  connections.clear();
  vi.clearAllMocks();
});

describe('GET /:login', () => {
  it('renders the alertsOverlaySource view with the lowercased login', async () => {
    const res = await supertest(buildApp()).get('/SomeChannel');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('alertsOverlaySource');
    expect(res.body.login).toBe('somechannel');
  });

  it('falls through (404) for a reserved login (settings)', async () => {
    const res = await supertest(buildApp()).get('/settings');
    expect(res.status).toBe(404);
  });

  it('falls through (404) for a reserved login (assets)', async () => {
    const res = await supertest(buildApp()).get('/assets');
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
    const dummies = new Set(
      Array.from({ length: MAX_SSE_CONNECTIONS_PER_CHANNEL }, () => ({}) as any),
    );
    connections.set('testchannel', dummies);

    const res = await supertest(buildApp()).get('/testchannel/events');
    expect(res.status).toBe(429);
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

    triggerClose();
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
      triggerClose();
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
});

describe('pushAlertEvent', () => {
  const alert = {
    type: 'follow' as const,
    message: 'Thanks testuser!',
    imageUrl: '/alerts/assets/1/follow.png',
    soundUrl: null,
    durationMs: 6000,
  };

  it('does nothing when there are no connections for the channel', () => {
    expect(() => pushAlertEvent('nobody', alert)).not.toThrow();
  });

  it('writes the alert payload to every connected client', () => {
    const res1 = { write: vi.fn() };
    const res2 = { write: vi.fn() };
    connections.set('livechannel', new Set([res1, res2] as any));

    pushAlertEvent('LiveChannel', alert);

    const expectedPayload = `data: ${JSON.stringify(alert)}\n\n`;
    expect(res1.write).toHaveBeenCalledWith(expectedPayload);
    expect(res2.write).toHaveBeenCalledWith(expectedPayload);
  });

  it('drops a client whose write throws but keeps the others', () => {
    const good = { write: vi.fn() };
    const dead = { write: vi.fn(() => { throw new Error('broken pipe'); }) };
    connections.set('mixedchannel', new Set([good, dead] as any));

    pushAlertEvent('mixedchannel', alert);

    const clients = connections.get('mixedchannel');
    expect(clients?.has(good as any)).toBe(true);
    expect(clients?.has(dead as any)).toBe(false);
  });

  it('deletes the map entry once every client has been dropped', () => {
    const dead = { write: vi.fn(() => { throw new Error('broken pipe'); }) };
    connections.set('emptiedchannel', new Set([dead] as any));

    pushAlertEvent('emptiedchannel', alert);

    expect(connections.has('emptiedchannel')).toBe(false);
  });
});

describe('GET /assets/:streamerId/:filename', () => {
  beforeEach(() => {
    vi.mocked(safeResolve).mockClear();
  });

  it('returns 400 for a non-numeric streamerId', async () => {
    const res = await supertest(buildApp()).get('/assets/abc/clip.png');
    expect(res.status).toBe(400);
  });

  it('returns 400 for a malformed filename', async () => {
    const res = await supertest(buildApp()).get('/assets/123/cl%20ip.png');
    expect(res.status).toBe(400);
  });

  it('returns 400 for a filename with a disallowed extension', async () => {
    const res = await supertest(buildApp()).get('/assets/123/clip.exe');
    expect(res.status).toBe(400);
  });

  it('returns 400 when safeResolve rejects the path as unsafe', async () => {
    vi.mocked(safeResolve).mockReturnValueOnce(null);
    const res = await supertest(buildApp()).get('/assets/123/clip.png');
    expect(res.status).toBe(400);
  });

  it('returns 404 when the file does not exist on disk', async () => {
    vi.mocked(fs.promises.access).mockRejectedValueOnce(new Error('ENOENT'));
    const res = await supertest(buildApp()).get('/assets/123/clip.png');
    expect(res.status).toBe(404);
  });

  it('sends the resolved file with a nosniff header when it exists', async () => {
    vi.mocked(fs.promises.access).mockResolvedValueOnce(undefined);
    const sendFileSpy = vi.fn();
    const app = express();
    app.use((req, res, next) => {
      (res as any).sendFile = (filePath: string) => { sendFileSpy(filePath); res.end(); };
      next();
    });
    app.use(router);
    const res = await supertest(app).get('/assets/123/clip.png');
    expect(res.status).toBe(200);
    expect(sendFileSpy).toHaveBeenCalledWith('/app/alert-assets/123/clip.png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toContain('image/png');
  });

  it('replies 404 instead of a raw 500 when sendFile errors after the access() check passed (TOCTOU race)', async () => {
    vi.mocked(fs.promises.access).mockResolvedValueOnce(undefined);
    const app = express();
    app.use((req, res, next) => {
      (res as any).sendFile = (_filePath: string, cb: (err: Error) => void) => cb(new Error('ENOENT'));
      next();
    });
    app.use(router);
    const res = await supertest(app).get('/assets/123/clip.png');
    expect(res.status).toBe(404);
  });

  it('sends an mp3 sound with the correct content type', async () => {
    vi.mocked(fs.promises.access).mockResolvedValueOnce(undefined);
    const sendFileSpy = vi.fn();
    const app = express();
    app.use((req, res, next) => {
      (res as any).sendFile = (filePath: string) => { sendFileSpy(filePath); res.end(); };
      next();
    });
    app.use(router);
    const res = await supertest(app).get('/assets/123/clip.mp3');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio/mpeg');
  });
});
