import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSseEventsHandler } from './sseChannel';

const LOGIN_RE = /^[a-zA-Z0-9_]{1,25}$/;
const RESERVED_LOGINS = new Set(['settings']);

function makeRes() {
  return {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    status: vi.fn().mockReturnThis(),
    end: vi.fn(),
  };
}

function makeReq(login: string) {
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

let connections: Map<string, Set<any>>;

beforeEach(() => {
  connections = new Map();
  vi.clearAllMocks();
});

function buildHandler(maxPerChannel = 10) {
  return createSseEventsHandler({ connections, loginRe: LOGIN_RE, reservedLogins: RESERVED_LOGINS, maxPerChannel });
}

describe('createSseEventsHandler', () => {
  it('calls next() for a malformed login', () => {
    const handler = buildHandler();
    const next = vi.fn();
    const { req } = makeReq('not-valid!');
    handler(req as any, makeRes() as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next() for a reserved login', () => {
    const handler = buildHandler();
    const next = vi.fn();
    const { req } = makeReq('settings');
    handler(req as any, makeRes() as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('registers the connection and sends the SSE handshake for a valid login', () => {
    const handler = buildHandler();
    const res = makeRes();
    const { req, triggerClose } = makeReq('freshchannel');

    handler(req as any, res as any, vi.fn());

    expect(connections.get('freshchannel')?.has(res as any)).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.write).toHaveBeenCalledWith(': connected\n\n');

    triggerClose();
  });

  it('lowercases the login before using it as a connection key', () => {
    const handler = buildHandler();
    const res = makeRes();
    const { req, triggerClose } = makeReq('SomeChannel');

    handler(req as any, res as any, vi.fn());

    expect(connections.has('somechannel')).toBe(true);
    triggerClose();
  });

  it('returns 429 when the per-channel connection limit is exceeded', () => {
    const handler = buildHandler(2);
    connections.set('full', new Set([{}, {}] as any));
    const res = makeRes();
    const { req } = makeReq('full');

    handler(req as any, res as any, vi.fn());

    expect(res.status).toHaveBeenCalledWith(429);
    expect(connections.get('full')?.has(res as any)).toBe(false);
  });

  it('sends a ping every 25 seconds', () => {
    vi.useFakeTimers();
    try {
      const handler = buildHandler();
      const res = makeRes();
      const { req, triggerClose } = makeReq('pingchannel');

      handler(req as any, res as any, vi.fn());
      res.write.mockClear();

      vi.advanceTimersByTime(25_000);
      expect(res.write).toHaveBeenCalledWith(': ping\n\n');
      triggerClose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts the client and clears the interval when a ping write fails', () => {
    vi.useFakeTimers();
    try {
      const handler = buildHandler();
      const res = makeRes();
      const { req } = makeReq('brokenpipe');

      handler(req as any, res as any, vi.fn());
      res.write.mockImplementation(() => {
        throw new Error('broken pipe');
      });

      vi.advanceTimersByTime(25_000);

      expect(connections.get('brokenpipe')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes the client (and empty Set) when the request closes', () => {
    const handler = buildHandler();
    const res = makeRes();
    const { req, triggerClose } = makeReq('closingchannel');

    handler(req as any, res as any, vi.fn());
    expect(connections.get('closingchannel')?.has(res as any)).toBe(true);

    triggerClose();
    expect(connections.get('closingchannel')).toBeUndefined();
  });

  it('removes only the closing client, keeping the channel entry when others remain', () => {
    const handler = buildHandler();
    const res1 = makeRes();
    const res2 = makeRes();
    const { req: req1, triggerClose: closeReq1 } = makeReq('sharedchannel');
    const { req: req2 } = makeReq('sharedchannel');

    handler(req1 as any, res1 as any, vi.fn());
    handler(req2 as any, res2 as any, vi.fn());

    closeReq1();
    expect(connections.get('sharedchannel')?.has(res1 as any)).toBe(false);
    expect(connections.get('sharedchannel')?.has(res2 as any)).toBe(true);
  });
});
