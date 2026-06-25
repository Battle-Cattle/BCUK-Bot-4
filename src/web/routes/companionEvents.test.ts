import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

// Stub auth: tests drive it via the `x-test-discord-id` header instead of a real token,
// so SSE route behaviour can be exercised without re-testing requireCompanionKey itself
// (that's covered in middleware.test.ts).
vi.mock('../middleware', () => ({
  requireCompanionKey: (req: any, res: any, next: any) => {
    const id = req.headers['x-test-discord-id'];
    if (!id) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    req.companionDiscordId = id;
    next();
  },
}));

import express from 'express';
import supertest from 'supertest';
import router, { pushCompanionEvent, MAX_SSE_CONNECTIONS_PER_TOKEN, connections, type CompanionEvent } from './companionEvents';

function buildApp() {
  const app = express();
  app.use(router);
  return app;
}

const sampleEvent: CompanionEvent = {
  type: 'channel_points_redemption',
  rewardId: 'r1',
  rewardTitle: 'Test Reward',
  userLogin: 'viewer1',
  userName: 'Viewer1',
  userInput: '',
  redeemedAt: new Date().toISOString(),
};

beforeEach(() => {
  connections.clear();
  vi.clearAllMocks();
});

describe('GET /events — auth', () => {
  it('returns 401 when no token-derived discord ID is present', async () => {
    const res = await supertest(buildApp()).get('/events');
    expect(res.status).toBe(401);
  });
});

describe('GET /events — connection limit', () => {
  it('returns 429 when the per-token slot is full', async () => {
    const dummies = new Set(Array.from({ length: MAX_SSE_CONNECTIONS_PER_TOKEN }, () => ({}) as any));
    connections.set('user1', dummies);

    const res = await supertest(buildApp()).get('/events').set('x-test-discord-id', 'user1');
    expect(res.status).toBe(429);
  });

  it('accepts a connection when below the limit', async () => {
    const req = supertest(buildApp()).get('/events').set('x-test-discord-id', 'user1');
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
    expect(status).toBe(200);
  });
});

describe('pushCompanionEvent', () => {
  it('writes the event payload to all connected clients for the given discord ID', () => {
    const res = { write: vi.fn() } as any;
    connections.set('user1', new Set([res]));

    pushCompanionEvent('user1', sampleEvent);

    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify(sampleEvent)}\n\n`);
  });

  it('does not deliver events to a different discord ID', () => {
    const resA = { write: vi.fn() } as any;
    const resB = { write: vi.fn() } as any;
    connections.set('userA', new Set([resA]));
    connections.set('userB', new Set([resB]));

    pushCompanionEvent('userA', sampleEvent);

    expect(resA.write).toHaveBeenCalled();
    expect(resB.write).not.toHaveBeenCalled();
  });

  it('removes dead connections that throw on write', () => {
    const deadRes = { write: vi.fn(() => { throw new Error('client gone'); }) } as any;
    const liveRes = { write: vi.fn() } as any;
    connections.set('user1', new Set([deadRes, liveRes]));

    pushCompanionEvent('user1', sampleEvent);

    expect(connections.get('user1')?.has(deadRes)).toBe(false);
    expect(connections.get('user1')?.has(liveRes)).toBe(true);
  });

  it('removes the discord ID entry entirely once all its connections are dead', () => {
    const deadRes = { write: vi.fn(() => { throw new Error('client gone'); }) } as any;
    connections.set('user1', new Set([deadRes]));

    pushCompanionEvent('user1', sampleEvent);

    expect(connections.has('user1')).toBe(false);
  });

  it('is a no-op when no clients are connected for the discord ID', () => {
    expect(() => pushCompanionEvent('nobody', sampleEvent)).not.toThrow();
  });
});
