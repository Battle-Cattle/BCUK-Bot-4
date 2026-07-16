import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/config', () => ({ SSE_MAX_TOTAL_CONNECTIONS: 10 }));

import { createSseEventsHandler, createLoginValidator, attachSseConnection, broadcastToChannel } from './sseChannel';

const LOGIN_RE = /^[a-zA-Z0-9_]{1,25}$/;
const RESERVED_LOGINS = new Set(['settings']);

function makeRes() {
  const handlers: Record<string, () => void> = {};
  return {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    status: vi.fn().mockReturnThis(),
    end: vi.fn(),
    on: vi.fn((event: string, cb: () => void) => { handlers[event] = cb; }),
    triggerResClose: () => handlers['close']?.(),
    triggerResError: () => handlers['error']?.(),
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

const isValidLogin = createLoginValidator(LOGIN_RE, RESERVED_LOGINS);

function buildHandler(maxPerChannel = 10) {
  return createSseEventsHandler({ connections, isValidLogin, maxPerChannel });
}

describe('createLoginValidator', () => {
  it('returns null for a malformed login', () => {
    expect(isValidLogin('not-valid!')).toBeNull();
  });

  it('returns null for a reserved login', () => {
    expect(isValidLogin('settings')).toBeNull();
    expect(isValidLogin('SETTINGS')).toBeNull();
  });

  it('returns the lowercased login for a valid one', () => {
    expect(isValidLogin('SomeChannel')).toBe('somechannel');
  });
});

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
    const { req: req2, triggerClose: closeReq2 } = makeReq('sharedchannel');

    handler(req1 as any, res1 as any, vi.fn());
    handler(req2 as any, res2 as any, vi.fn());

    closeReq1();
    expect(connections.get('sharedchannel')?.has(res1 as any)).toBe(false);
    expect(connections.get('sharedchannel')?.has(res2 as any)).toBe(true);
    closeReq2();
  });
});

describe('attachSseConnection', () => {
  it('registers the connection under an arbitrary key type (e.g. a numeric streamer ID)', () => {
    const numericConnections = new Map<number, Set<any>>();
    const res = makeRes();
    const { req, triggerClose } = makeReq('unused');

    const attached = attachSseConnection(req as any, res as any, { connections: numericConnections, key: 42, maxPerChannel: 5 });

    expect(attached).toBe(true);
    expect(numericConnections.get(42)?.has(res as any)).toBe(true);
    expect(res.write).toHaveBeenCalledWith(': connected\n\n');
    triggerClose();
  });

  it('returns false and replies 429 when the key is already at its connection limit', () => {
    const res = makeRes();
    const { req } = makeReq('unused');
    connections.set('full', new Set([{}, {}] as any));

    const attached = attachSseConnection(req as any, res as any, { connections, key: 'full', maxPerChannel: 2 });

    expect(attached).toBe(false);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(connections.get('full')?.has(res as any)).toBe(false);
  });

  it('cleans up on request close', () => {
    const res = makeRes();
    const { req, triggerClose } = makeReq('unused');

    attachSseConnection(req as any, res as any, { connections, key: 'somekey', maxPerChannel: 5 });
    expect(connections.get('somekey')?.has(res as any)).toBe(true);

    triggerClose();
    expect(connections.get('somekey')).toBeUndefined();
  });

  it('cleans up on a response close event, even if the request never closes', () => {
    const res = makeRes();
    const { req } = makeReq('unused');

    attachSseConnection(req as any, res as any, { connections, key: 'somekey', maxPerChannel: 5 });
    expect(connections.get('somekey')?.has(res as any)).toBe(true);

    res.triggerResClose();
    expect(connections.get('somekey')).toBeUndefined();
  });

  it('cleans up on a response error event, even if the request never closes', () => {
    const res = makeRes();
    const { req } = makeReq('unused');

    attachSseConnection(req as any, res as any, { connections, key: 'somekey', maxPerChannel: 5 });
    expect(connections.get('somekey')?.has(res as any)).toBe(true);

    res.triggerResError();
    expect(connections.get('somekey')).toBeUndefined();
  });

  it('only cleans up once when close and error both fire for the same connection', () => {
    vi.useFakeTimers();
    try {
      const res = makeRes();
      const { req, triggerClose } = makeReq('unused');

      attachSseConnection(req as any, res as any, { connections, key: 'somekey', maxPerChannel: 5 });

      res.triggerResError();
      triggerClose();
      res.triggerResClose();

      // Idempotent cleanup means the keepalive interval was cleared once — advancing time
      // shouldn't produce a further ping write attempt on the already-evicted response.
      res.write.mockClear();
      vi.advanceTimersByTime(25_000);
      expect(res.write).not.toHaveBeenCalled();
      expect(connections.get('somekey')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Process-wide SSE connection cap (SSE_MAX_TOTAL_CONNECTIONS, mocked to 10 above)
// ---------------------------------------------------------------------------
describe('attachSseConnection — process-wide connection cap', () => {
  it('rejects with 429 once the process-wide cap is reached, even under distinct keys well under their own maxPerChannel', () => {
    const opened: Array<() => void> = [];
    for (let i = 0; i < 10; i++) {
      const res = makeRes();
      const { req, triggerClose } = makeReq('unused');
      const attached = attachSseConnection(req as any, res as any, { connections, key: `key-${i}`, maxPerChannel: 100 });
      expect(attached).toBe(true);
      opened.push(triggerClose);
    }

    const overflowRes = makeRes();
    const { req: overflowReq } = makeReq('unused');
    const attached = attachSseConnection(overflowReq as any, overflowRes as any, { connections, key: 'key-overflow', maxPerChannel: 100 });

    expect(attached).toBe(false);
    expect(overflowRes.status).toHaveBeenCalledWith(429);
    expect(connections.get('key-overflow')).toBeUndefined();

    opened.forEach((close) => close());
  });

  it('frees a slot when a connection cleans up, allowing a new one to attach', () => {
    const opened: Array<() => void> = [];
    for (let i = 0; i < 10; i++) {
      const res = makeRes();
      const { req, triggerClose } = makeReq('unused');
      attachSseConnection(req as any, res as any, { connections, key: `key-${i}`, maxPerChannel: 100 });
      opened.push(triggerClose);
    }

    opened[0]();

    const res = makeRes();
    const { req, triggerClose } = makeReq('unused');
    const attached = attachSseConnection(req as any, res as any, { connections, key: 'key-new', maxPerChannel: 100 });

    expect(attached).toBe(true);
    triggerClose();
    opened.slice(1).forEach((close) => close());
  });
});

// ---------------------------------------------------------------------------
// broadcastToChannel
// ---------------------------------------------------------------------------
describe('broadcastToChannel', () => {
  it('returns null and writes nothing when no clients are connected under the key', () => {
    const result = broadcastToChannel(connections, 'nobody', { hello: 'world' });
    expect(result).toBeNull();
  });

  it('writes the JSON-serialized payload as an SSE data frame to every connected client', () => {
    const res1 = makeRes();
    const res2 = makeRes();
    connections.set('somekey', new Set([res1 as any, res2 as any]));

    const result = broadcastToChannel(connections, 'somekey', { hello: 'world' });

    expect(result).toBe(2);
    expect(res1.write).toHaveBeenCalledWith('data: {"hello":"world"}\n\n');
    expect(res2.write).toHaveBeenCalledWith('data: {"hello":"world"}\n\n');
  });

  it('evicts a client whose write fails and returns the remaining count', () => {
    const good = makeRes();
    const dead = makeRes();
    dead.write.mockImplementation(() => { throw new Error('broken pipe'); });
    connections.set('somekey', new Set([good as any, dead as any]));

    const result = broadcastToChannel(connections, 'somekey', { x: 1 });

    expect(result).toBe(1);
    expect(connections.get('somekey')?.has(dead as any)).toBe(false);
    expect(connections.get('somekey')?.has(good as any)).toBe(true);
  });

  it('deletes the map entry and returns 0 when every client fails to write', () => {
    const dead = makeRes();
    dead.write.mockImplementation(() => { throw new Error('broken pipe'); });
    connections.set('somekey', new Set([dead as any]));

    const result = broadcastToChannel(connections, 'somekey', { x: 1 });

    expect(result).toBe(0);
    expect(connections.has('somekey')).toBe(false);
  });
});
