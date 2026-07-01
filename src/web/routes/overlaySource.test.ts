import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../shared/config', () => ({
  OVERLAY_FOLDER: '/app/overlay-videos',
}));

vi.mock('fs', () => ({
  default: {
    promises: { access: vi.fn() },
    readdirSync: () => ['controllerOverlay.ejs', 'overlaySource.ejs'],
  },
}));

import express from 'express';
import supertest from 'supertest';
import router, { MAX_SSE_CONNECTIONS_PER_CHANNEL, connections } from './overlaySource';

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
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to 10', async () => {
    vi.stubEnv('OVERLAY_MAX_SSE_PER_CHANNEL', '');
    vi.resetModules();
    const { MAX_SSE_CONNECTIONS_PER_CHANNEL: limit } = await import('./overlaySource.js');
    expect(limit).toBe(10);
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
});
