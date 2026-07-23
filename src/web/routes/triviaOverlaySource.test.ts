import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({ TRIVIA_MAX_SSE_PER_CHANNEL: 10, SSE_MAX_TOTAL_CONNECTIONS: 1000 }));
vi.mock('../../trivia/triviaGame', () => ({ notifyConnectionCountChanged: vi.fn() }));
vi.mock('fs', () => ({
  default: { readdirSync: () => ['triviaOverlaySource.ejs'] },
}));

import express from 'express';
import supertest from 'supertest';
import router, { MAX_SSE_CONNECTIONS_PER_CHANNEL, connections, pushTriviaEvent } from './triviaOverlaySource';
import { notifyConnectionCountChanged } from '../../trivia/triviaGame';
import { __resetTriviaChannelGroupForTests } from '../../trivia/triviaChannelGroup';

const REAL_GUILD_ID = '123456789012345678';
const OTHER_GUILD_ID = '876543210987654321';

/** Finds a route's handler function directly from the router's internal stack, bypassing HTTP entirely. */
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

function makeSseReq(login: string, query: Record<string, unknown> = {}) {
  // attachSseConnection registers its own 'close' cleanup listener, and the route handler
  // registers a second one afterwards (to refresh the group's connection count post-removal) —
  // both must fire, in registration order, for triggerClose() to behave like a real EventEmitter.
  const closeCbs: (() => void)[] = [];
  return {
    req: {
      params: { login },
      query,
      on: (event: string, cb: () => void) => {
        if (event === 'close') closeCbs.push(cb);
      },
    },
    triggerClose: () => { for (const cb of closeCbs) cb(); },
  };
}

function buildApp() {
  const app = express();
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
  __resetTriviaChannelGroupForTests();
});

describe('GET /:login', () => {
  it('renders the triviaOverlaySource view with the lowercased login', async () => {
    const res = await supertest(buildApp()).get('/SomeChannel');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('triviaOverlaySource');
    expect(res.body.login).toBe('somechannel');
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

describe('GET /:login/events — connection limit and validation', () => {
  it('returns 429 when the per-channel slot is full', async () => {
    const dummies = new Set(Array.from({ length: MAX_SSE_CONNECTIONS_PER_CHANNEL }, () => ({}) as any));
    connections.set('testchannel', dummies);

    const res = await supertest(buildApp()).get('/testchannel/events');
    expect(res.status).toBe(429);
  });

  it('falls through (404) for a malformed login', async () => {
    const res = await supertest(buildApp()).get('/not-valid!/events');
    expect(res.status).toBe(404);
  });
});

describe('GET /:login/events — connection lifecycle', () => {
  it('registers a new connection as a solo group when no guild param is given', () => {
    const handler = getRouteHandler('/:login/events');
    const res = makeSseRes();
    const { req } = makeSseReq('freshchannel');

    handler(req, res, vi.fn());

    expect(connections.get('freshchannel')?.has(res as any)).toBe(true);
    expect(notifyConnectionCountChanged).toHaveBeenCalledWith('freshchannel', 1);
  });

  it('groups the connection by a valid guild query param instead of its own login', () => {
    const handler = getRouteHandler('/:login/events');
    const res = makeSseRes();
    const { req } = makeSseReq('freshchannel', { guild: REAL_GUILD_ID });

    handler(req, res, vi.fn());

    expect(notifyConnectionCountChanged).toHaveBeenCalledWith(REAL_GUILD_ID, 1);
  });

  it('falls back to a solo group when the guild query param is not a valid snowflake', () => {
    const handler = getRouteHandler('/:login/events');
    const res = makeSseRes();
    const { req } = makeSseReq('freshchannel', { guild: 'not-a-real-id' });

    handler(req, res, vi.fn());

    expect(notifyConnectionCountChanged).toHaveBeenCalledWith('freshchannel', 1);
  });

  it('falls back to a solo group when the guild query param is repeated (arrives as an array)', () => {
    const handler = getRouteHandler('/:login/events');
    const res = makeSseRes();
    const { req } = makeSseReq('freshchannel', { guild: [REAL_GUILD_ID, OTHER_GUILD_ID] });

    handler(req, res, vi.fn());

    expect(notifyConnectionCountChanged).toHaveBeenCalledWith('freshchannel', 1);
  });

  it('notifies the game engine with 0 once the client disconnects', () => {
    const handler = getRouteHandler('/:login/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('closingchannel');

    handler(req, res, vi.fn());
    vi.mocked(notifyConnectionCountChanged).mockClear();

    triggerClose();

    expect(notifyConnectionCountChanged).toHaveBeenCalledWith('closingchannel', 0);
    expect(connections.get('closingchannel')).toBeUndefined();
  });

  it('sums connected clients across every channel sharing the same guild param', () => {
    const handler = getRouteHandler('/:login/events');

    const resA = makeSseRes();
    handler(makeSseReq('channela', { guild: REAL_GUILD_ID }).req, resA, vi.fn());
    expect(notifyConnectionCountChanged).toHaveBeenCalledWith(REAL_GUILD_ID, 1);

    const resB = makeSseRes();
    handler(makeSseReq('channelb', { guild: REAL_GUILD_ID }).req, resB, vi.fn());
    expect(notifyConnectionCountChanged).toHaveBeenCalledWith(REAL_GUILD_ID, 2);
  });
});

describe('pushTriviaEvent', () => {
  const event = { type: 'idle' } as const;

  it('does nothing for a group with no known membership', () => {
    expect(() => pushTriviaEvent('nobody', event)).not.toThrow();
  });

  it('broadcasts to every login currently sharing the group', () => {
    const handler = getRouteHandler('/:login/events');

    const resA = makeSseRes();
    handler(makeSseReq('channela', { guild: REAL_GUILD_ID }).req, resA, vi.fn());
    const resB = makeSseRes();
    handler(makeSseReq('channelb', { guild: REAL_GUILD_ID }).req, resB, vi.fn());

    resA.write.mockClear();
    resB.write.mockClear();
    pushTriviaEvent(REAL_GUILD_ID, event);

    const expectedPayload = `data: ${JSON.stringify(event)}\n\n`;
    expect(resA.write).toHaveBeenCalledWith(expectedPayload);
    expect(resB.write).toHaveBeenCalledWith(expectedPayload);
  });

  it('does not broadcast to a channel that opted into a different guild', () => {
    const handler = getRouteHandler('/:login/events');

    const resA = makeSseRes();
    handler(makeSseReq('channela', { guild: REAL_GUILD_ID }).req, resA, vi.fn());
    const resC = makeSseRes();
    handler(makeSseReq('channelc', { guild: OTHER_GUILD_ID }).req, resC, vi.fn());

    resA.write.mockClear();
    resC.write.mockClear();
    pushTriviaEvent(REAL_GUILD_ID, event);

    expect(resA.write).toHaveBeenCalled();
    expect(resC.write).not.toHaveBeenCalled();
  });
});
