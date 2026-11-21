import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// One shared logger instance, so a test can assert what the module logged.
const { mockLog } = vi.hoisted(() => ({ mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../shared/logger', () => ({ createLogger: () => mockLog }));
vi.mock('../shared/config', () => ({ SSE_MAX_TOTAL_CONNECTIONS: 1000 }));
// The fake responses below were never attached through attachSseConnection, so its cleanup chain is stubbed.
const { chainConnectionCleanup } = vi.hoisted(() => ({ chainConnectionCleanup: vi.fn(() => true) }));
vi.mock('./routes/sseChannel', () => ({ chainConnectionCleanup }));

import { EventEmitter } from 'events';
import express from 'express';
import session from 'express-session';
import type { Request, Response } from 'express';
import {
  registerSessionStream, closeSessionStreams, closeUserStreams, wrapStoreDestroy,
  getSessionStreamStats, resetSessionStreamsForTests, TOMBSTONE_TTL_MS, MAX_TRACKED_ENTRIES,
} from './sessionStreams';
import { SESSION_IDLE_MS, SESSION_ABSOLUTE_MAX_MS } from './sessionLifetime';

/** A response stand-in: an emitter whose `end()` records the call and emits `close`, as a real one does. */
function fakeRes(): Response & { end: ReturnType<typeof vi.fn> } {
  const res = new EventEmitter() as unknown as Response & { end: ReturnType<typeof vi.fn> };
  res.end = vi.fn(() => { res.emit('close'); return res; });
  return res;
}

/** A request stand-in for a signed-in session. */
function fakeReq(sessionID: string, discordId = '42', sessionGeneration?: number, extra: Record<string, unknown> = {}): Request {
  const req = new EventEmitter() as unknown as Request;
  Object.assign(req, { sessionID, session: { user: { discordId }, sessionGeneration, ...extra } });
  return req;
}

beforeEach(() => {
  resetSessionStreamsForTests();
  chainConnectionCleanup.mockReset();
  chainConnectionCleanup.mockReturnValue(true);
});

describe('registerSessionStream and closeSessionStreams', () => {
  it('closes only the streams of the destroyed session', () => {
    const a = fakeRes();
    const b = fakeRes();
    expect(registerSessionStream(fakeReq('s1'), a, 'status')).toBe(true);
    expect(registerSessionStream(fakeReq('s2'), b, 'status')).toBe(true);

    closeSessionStreams('s1');

    expect(a.end).toHaveBeenCalledTimes(1);
    expect(b.end).not.toHaveBeenCalled();
    expect(getSessionStreamStats().streams).toBe(1);
  });

  it('closes every stream a session holds, whatever its kind', () => {
    const status = fakeRes();
    const events = fakeRes();
    registerSessionStream(fakeReq('s1'), status, 'status');
    registerSessionStream(fakeReq('s1'), events, 'events');

    closeSessionStreams('s1');

    expect(status.end).toHaveBeenCalledTimes(1);
    expect(events.end).toHaveBeenCalledTimes(1);
  });

  it('refuses a stream that registers after its session was destroyed (the load-then-attach race)', () => {
    closeSessionStreams('s1');
    const late = fakeRes();

    expect(registerSessionStream(fakeReq('s1'), late, 'status')).toBe(false);
    expect(late.end).toHaveBeenCalledTimes(1);
    expect(getSessionStreamStats().streams).toBe(0);
    // Another session is unaffected.
    expect(registerSessionStream(fakeReq('s2'), fakeRes(), 'status')).toBe(true);
  });

  it('chains its cleanup onto the connection\'s own, so a failed broadcast or keepalive write also unregisters it', () => {
    const res = fakeRes();
    registerSessionStream(fakeReq('s1'), res, 'status');

    expect(chainConnectionCleanup).toHaveBeenCalledWith(res, expect.any(Function));
    const chained = (chainConnectionCleanup.mock.calls[0] as unknown as [Response, () => void])[1];
    chained();
    expect(getSessionStreamStats().streams).toBe(0);
  });

  it('does not keep a registration for a connection that was already torn down', () => {
    chainConnectionCleanup.mockReturnValue(false);

    registerSessionStream(fakeReq('s1'), fakeRes(), 'status');

    expect(getSessionStreamStats().streams).toBe(0);
  });

  it('refuses a stream with no signed-in user', () => {
    const res = fakeRes();
    const req = fakeReq('s1');
    (req.session as unknown as { user?: unknown }).user = undefined;

    expect(registerSessionStream(req, res, 'status')).toBe(false);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('forgets a destroyed session after the tombstone TTL', () => {
    vi.useFakeTimers();
    try {
      closeSessionStreams('s1');
      vi.advanceTimersByTime(TOMBSTONE_TTL_MS + 1);

      expect(registerSessionStream(fakeReq('s1'), fakeRes(), 'status')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the tombstones it keeps, dropping the oldest first', () => {
    for (let i = 0; i < MAX_TRACKED_ENTRIES + 5; i++) closeSessionStreams(`sid-${i}`);

    expect(getSessionStreamStats().tombstones).toBe(MAX_TRACKED_ENTRIES);
    expect(registerSessionStream(fakeReq('sid-0'), fakeRes(), 'status')).toBe(true);
    expect(registerSessionStream(fakeReq(`sid-${MAX_TRACKED_ENTRIES + 4}`), fakeRes(), 'status')).toBe(false);
  });

  it('keeps closing the rest when one stream throws on end', () => {
    const bad = fakeRes();
    bad.end = vi.fn(() => { throw new Error('socket gone'); });
    const good = fakeRes();
    registerSessionStream(fakeReq('s1'), bad, 'status');
    registerSessionStream(fakeReq('s1'), good, 'events');

    expect(() => closeSessionStreams('s1')).not.toThrow();

    expect(good.end).toHaveBeenCalledTimes(1);
    expect(getSessionStreamStats().streams).toBe(0);
  });
});

describe('closeUserStreams (sign out other sessions)', () => {
  it('closes the user\'s streams from older generations and leaves the new generation and other users alone', () => {
    const old = fakeRes();
    const fresh = fakeRes();
    const other = fakeRes();
    registerSessionStream(fakeReq('s1', '42', 0), old, 'status');
    registerSessionStream(fakeReq('s2', '42', 1), fresh, 'status');
    registerSessionStream(fakeReq('s3', '77', 0), other, 'status');

    closeUserStreams('42', 1);

    expect(old.end).toHaveBeenCalledTimes(1);
    expect(fresh.end).not.toHaveBeenCalled();
    expect(other.end).not.toHaveBeenCalled();
  });

  it('treats a session with no generation as generation 0', () => {
    const res = fakeRes();
    registerSessionStream(fakeReq('s1', '42', undefined), res, 'status');

    closeUserStreams('42', 1);

    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('refuses a late stream from an older generation but accepts the current one', () => {
    closeUserStreams('42', 2);

    expect(registerSessionStream(fakeReq('s1', '42', 1), fakeRes(), 'status')).toBe(false);
    expect(registerSessionStream(fakeReq('s2', '42', 2), fakeRes(), 'status')).toBe(true);
    expect(registerSessionStream(fakeReq('s3', '77', 0), fakeRes(), 'status')).toBe(true);
  });

  it('forgets the minimum generation after the TTL', () => {
    vi.useFakeTimers();
    try {
      closeUserStreams('42', 2);
      vi.advanceTimersByTime(TOMBSTONE_TTL_MS + 1);

      expect(registerSessionStream(fakeReq('s1', '42', 1), fakeRes(), 'status')).toBe(true);
      expect(getSessionStreamStats().minGenerations).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never lowers the minimum generation it already holds', () => {
    closeUserStreams('42', 3);
    closeUserStreams('42', 1);

    expect(registerSessionStream(fakeReq('s1', '42', 2), fakeRes(), 'status')).toBe(false);
  });
});

describe('cleanup when a stream ends by itself', () => {
  it.each([
    ['res close', (req: Request, res: Response) => { void req; res.emit('close'); }],
    ['req close', (req: Request) => { req.emit('close'); }],
    ['res error', (_req: Request, res: Response) => { res.emit('error', new Error('boom')); }],
  ])('drops the registration and its timer on %s', (_name, end) => {
    vi.useFakeTimers();
    try {
      const req = fakeReq('s1', '42', 0, { lastSeenAt: Date.now() });
      const res = fakeRes();
      res.on('error', () => {});
      registerSessionStream(req, res, 'status');
      expect(getSessionStreamStats().streams).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      end(req, res);

      expect(getSessionStreamStats()).toMatchObject({ streams: 0, bySession: 0, byUser: 0 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('closing at the session\'s own end time', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends the stream when the session goes idle for 24 hours', () => {
    vi.useFakeTimers();
    const start = Date.now();
    const res = fakeRes();
    registerSessionStream(fakeReq('s1', '42', 0, { lastSeenAt: start, loginAt: start }), res, 'status');

    vi.advanceTimersByTime(SESSION_IDLE_MS - 1);
    expect(res.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);

    expect(res.end).toHaveBeenCalledTimes(1);
    expect(getSessionStreamStats().streams).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends the stream at the cookie\'s own expiry when that is the earliest time', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const res = fakeRes();
    const cookie = { expires: new Date(now + 60_000) };
    registerSessionStream(fakeReq('s1', '42', 0, { lastSeenAt: now, loginAt: now, cookie }), res, 'status');

    vi.advanceTimersByTime(59_999);
    expect(res.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);

    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('ends the stream at the 7-day cap when that comes first', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const res = fakeRes();
    registerSessionStream(fakeReq('s1', '42', 0, { lastSeenAt: now, loginAt: now - SESSION_ABSOLUTE_MAX_MS + 1000 }), res, 'status');

    vi.advanceTimersByTime(1001);

    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('sets no timer for a session that records no times and has no cookie expiry', () => {
    vi.useFakeTimers();
    registerSessionStream(fakeReq('s1'), fakeRes(), 'status');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not keep the process alive for a stream\'s timer', () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => ({ unref })) as unknown as typeof setTimeout);
    try {
      registerSessionStream(fakeReq('s1', '42', 0, { lastSeenAt: Date.now() }), fakeRes(), 'status');
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('wrapStoreDestroy', () => {
  it('closes the session\'s streams, then calls the real destroy with its callback and returns its value', () => {
    const calls: string[] = [];
    const res = fakeRes();
    res.end = vi.fn(() => { calls.push('end'); res.emit('close'); return res; });
    registerSessionStream(fakeReq('s1'), res, 'status');
    const destroy = vi.fn((_sid: string, cb?: (err?: unknown) => void) => { calls.push('destroy'); cb?.(); return 'result'; });
    const store = { destroy } as unknown as session.Store;
    wrapStoreDestroy(store);
    const cb = vi.fn();

    const returned = (store.destroy as unknown as (sid: string, cb: () => void) => unknown)('s1', cb);

    expect(calls).toEqual(['end', 'destroy']);
    expect(destroy).toHaveBeenCalledWith('s1', cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(returned).toBe('result');
  });

  it('still destroys the session, and passes its error on, when closing a stream throws', async () => {
    const bad = fakeRes();
    bad.end = vi.fn(() => { throw new Error('socket gone'); });
    registerSessionStream(fakeReq('s1'), bad, 'status');
    const failure = new Error('db down');
    const store = { destroy: vi.fn((_sid: string, cb?: (err?: unknown) => void) => { cb?.(failure); }) } as unknown as session.Store;
    wrapStoreDestroy(store);
    const cb = vi.fn();

    (store.destroy as unknown as (sid: string, cb: (err?: unknown) => void) => void)('s1', cb);

    expect(cb).toHaveBeenCalledWith(failure);
  });

  it('logs, and still runs the real destroy, when closing the streams throws unexpectedly', () => {
    registerSessionStream(fakeReq('s1', '42', 0, { lastSeenAt: Date.now() }), fakeRes(), 'status');
    const destroy = vi.fn();
    const store = { destroy } as unknown as session.Store;
    wrapStoreDestroy(store);
    const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => { throw new Error('boom'); });
    try {
      (store.destroy as unknown as (sid: string) => void)('s1');
    } finally {
      clear.mockRestore();
    }

    expect(destroy).toHaveBeenCalledWith('s1');
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Failed to close the dashboard streams'), expect.any(Error));
  });

  it('keeps a promise-returning destroy (as the MySQL store has) returning its promise', async () => {
    const store = { destroy: vi.fn(async () => 'done') } as unknown as session.Store;
    wrapStoreDestroy(store);

    await expect((store.destroy as unknown as (sid: string) => Promise<string>)('s1')).resolves.toBe('done');
  });
});

describe('with a real express-session and MemoryStore', () => {
  /** Boots an app whose store is wrapped, signs in, and returns helpers to destroy or regenerate that session. */
  async function boot() {
    const store = new session.MemoryStore();
    wrapStoreDestroy(store);
    const app = express();
    const results: { sid?: string } = {};
    app.use(session({ secret: 'x'.repeat(32), resave: false, saveUninitialized: false, store }));
    app.get('/login', (req, res) => {
      req.session.user = { discordId: '42', discordName: 'u', discordAvatar: null, isOwner: false, accessLevel: 0, currentGuildId: 'g1', guilds: [] };
      results.sid = req.sessionID;
      res.sendStatus(204);
    });
    app.get('/stream', (req, res) => {
      const stream = fakeRes();
      (globalThis as { lastStream?: unknown }).lastStream = stream;
      // A stand-in request: the real one closes when this test's HTTP response ends, which an open SSE stream's never does.
      const open = Object.assign(new EventEmitter(), { sessionID: req.sessionID, session: req.session }) as unknown as Request;
      res.send(String(registerSessionStream(open, stream, 'status')));
    });
    app.get('/destroy', (req, res) => { req.session.destroy(() => res.sendStatus(204)); });
    app.get('/regenerate', (req, res) => { req.session.regenerate(() => res.sendStatus(204)); });
    const supertest = (await import('supertest')).default;
    const cookie = (await supertest(app).get('/login')).headers['set-cookie']?.[0]?.split(';')[0] ?? '';
    return { app, cookie, supertest, results };
  }

  it('closes the session\'s stream on req.session.destroy and refuses a later attach under that ID', async () => {
    const { app, cookie, supertest, results } = await boot();
    await supertest(app).get('/stream').set('Cookie', cookie);
    const stream = (globalThis as unknown as { lastStream: { end: ReturnType<typeof vi.fn> } }).lastStream;

    await supertest(app).get('/destroy').set('Cookie', cookie);

    expect(stream.end).toHaveBeenCalledTimes(1);
    expect(results.sid).toBeTruthy();
    expect(registerSessionStream(fakeReq(results.sid as string), fakeRes(), 'status')).toBe(false);
  });

  it('closes the old ID\'s stream on regenerate (account switch) and leaves other sessions alone', async () => {
    const { app, cookie, supertest } = await boot();
    await supertest(app).get('/stream').set('Cookie', cookie);
    const stream = (globalThis as unknown as { lastStream: { end: ReturnType<typeof vi.fn> } }).lastStream;
    const otherStream = fakeRes();
    registerSessionStream(fakeReq('another-session'), otherStream, 'status');

    await supertest(app).get('/regenerate').set('Cookie', cookie);

    expect(stream.end).toHaveBeenCalledTimes(1);
    expect(otherStream.end).not.toHaveBeenCalled();
  });
});
