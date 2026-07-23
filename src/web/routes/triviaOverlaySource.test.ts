import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({ TRIVIA_MAX_SSE_PER_CHANNEL: 10, SSE_MAX_TOTAL_CONNECTIONS: 1000 }));
vi.mock('../../trivia/triviaSessionGroup', () => ({ resolveTriviaGroup: vi.fn() }));
vi.mock('../../trivia/triviaGame', () => ({ notifyConnectionCountChanged: vi.fn() }));
vi.mock('fs', () => ({
  default: { readdirSync: () => ['triviaOverlaySource.ejs'] },
}));

import express from 'express';
import supertest from 'supertest';
import router, { MAX_SSE_CONNECTIONS_PER_CHANNEL, connections, pushTriviaEvent } from './triviaOverlaySource';
import { resolveTriviaGroup } from '../../trivia/triviaSessionGroup';
import { notifyConnectionCountChanged } from '../../trivia/triviaGame';

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

function makeSseReq(login: string) {
  // attachSseConnection registers its own 'close' cleanup listener, and the route handler
  // registers a second one afterwards (to reconcile the trivia group post-removal) — both must
  // fire, in registration order, for triggerClose() to behave like a real EventEmitter.
  const closeCbs: (() => void)[] = [];
  return {
    req: {
      params: { login },
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

function soloGroup(login: string) {
  return { groupKey: login, members: [login] };
}

beforeEach(() => {
  connections.clear();
  vi.clearAllMocks();
  vi.mocked(resolveTriviaGroup).mockImplementation(async (login: string) => soloGroup(login));
});

afterEach(() => {
  vi.useRealTimers();
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
  it('registers a new connection and resolves its trivia group on connect', async () => {
    const handler = getRouteHandler('/:login/events');
    const res = makeSseRes();
    const { req } = makeSseReq('freshchannel');

    handler(req, res, vi.fn());
    await vi.waitFor(() => expect(resolveTriviaGroup).toHaveBeenCalledWith('freshchannel'));

    expect(connections.get('freshchannel')?.has(res as any)).toBe(true);
    expect(notifyConnectionCountChanged).toHaveBeenCalledWith('freshchannel', 1);
  });

  it('notifies the game engine with 0 once the client disconnects', async () => {
    const handler = getRouteHandler('/:login/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('closingchannel');

    handler(req, res, vi.fn());
    await vi.waitFor(() => expect(resolveTriviaGroup).toHaveBeenCalledWith('closingchannel'));
    vi.mocked(notifyConnectionCountChanged).mockClear();

    triggerClose();
    await vi.waitFor(() => expect(notifyConnectionCountChanged).toHaveBeenCalledWith('closingchannel', 0));

    expect(connections.get('closingchannel')).toBeUndefined();
  });

  it('sums connected clients across every channel in a shared-chat group', async () => {
    vi.mocked(resolveTriviaGroup).mockImplementation(async () => ({
      groupKey: 'session-1',
      members: ['channela', 'channelb'],
    }));

    const handlerA = getRouteHandler('/:login/events');
    const resA = makeSseRes();
    const { req: reqA } = makeSseReq('channela');
    handlerA(reqA, resA, vi.fn());
    await vi.waitFor(() => expect(notifyConnectionCountChanged).toHaveBeenCalledWith('session-1', 1));

    const resB = makeSseRes();
    const { req: reqB } = makeSseReq('channelb');
    handlerA(reqB, resB, vi.fn());
    await vi.waitFor(() => expect(notifyConnectionCountChanged).toHaveBeenCalledWith('session-1', 2));
  });

  it('notifies the previous group with its updated count when a channel moves to a new group', async () => {
    const handler = getRouteHandler('/:login/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('movingchannel');

    handler(req, res, vi.fn());
    await vi.waitFor(() => expect(notifyConnectionCountChanged).toHaveBeenCalledWith('movingchannel', 1));

    vi.mocked(resolveTriviaGroup).mockImplementation(async () => ({
      groupKey: 'new-session',
      members: ['movingchannel', 'partnerchannel'],
    }));
    vi.mocked(notifyConnectionCountChanged).mockClear();

    triggerClose();
    await vi.waitFor(() => expect(notifyConnectionCountChanged).toHaveBeenCalledWith('new-session', 0));
    expect(notifyConnectionCountChanged).toHaveBeenCalledWith('movingchannel', 0);
  });
});

describe('pushTriviaEvent', () => {
  const event = { type: 'idle' } as const;

  it('does nothing for a group with no known membership', () => {
    expect(() => pushTriviaEvent('nobody', event)).not.toThrow();
  });

  it('broadcasts to every login currently in the group', async () => {
    vi.mocked(resolveTriviaGroup).mockImplementation(async () => ({
      groupKey: 'session-1',
      members: ['channela', 'channelb'],
    }));

    const handler = getRouteHandler('/:login/events');
    const resA = makeSseRes();
    handler(makeSseReq('channela').req, resA, vi.fn());
    await vi.waitFor(() => expect(notifyConnectionCountChanged).toHaveBeenCalledWith('session-1', 1));

    const resB = makeSseRes();
    handler(makeSseReq('channelb').req, resB, vi.fn());
    await vi.waitFor(() => expect(notifyConnectionCountChanged).toHaveBeenCalledWith('session-1', 2));

    resA.write.mockClear();
    resB.write.mockClear();
    pushTriviaEvent('session-1', event);

    const expectedPayload = `data: ${JSON.stringify(event)}\n\n`;
    expect(resA.write).toHaveBeenCalledWith(expectedPayload);
    expect(resB.write).toHaveBeenCalledWith(expectedPayload);
  });
});
