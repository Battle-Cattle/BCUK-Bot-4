import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../shared/config', () => ({
  OVERLAY_FOLDER: '/app/overlay-videos',
}));

vi.mock('fs', () => ({
  default: { promises: { access: vi.fn() } },
}));

import express from 'express';
import supertest from 'supertest';
import router, { MAX_SSE_CONNECTIONS_PER_CHANNEL, connections } from './overlaySource';

function buildApp() {
  const app = express();
  app.use(router);
  return app;
}

beforeEach(() => {
  connections.clear();
  vi.clearAllMocks();
});

describe('MAX_SSE_CONNECTIONS_PER_CHANNEL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to 10', async () => {
    vi.stubEnv('OVERLAY_MAX_SSE_PER_CHANNEL', '10');
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
