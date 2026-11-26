import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// One shared logger instance, so a test can assert what the module logged.
const { mockLog } = vi.hoisted(() => ({ mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../shared/logger', () => ({ createLogger: () => mockLog }));
vi.mock('../shared/config', () => ({ SSE_MAX_TOTAL_CONNECTIONS: 1000 }));
// The fake responses below were never attached through attachSseConnection, so its cleanup chain is stubbed.
const { chainConnectionCleanup } = vi.hoisted(() => ({ chainConnectionCleanup: vi.fn(() => true) }));
vi.mock('./routes/sseChannel', () => ({ chainConnectionCleanup }));

import { EventEmitter } from 'events';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import session from 'express-session';
import type { Request, Response } from 'express';
import {
  registerSessionStream, closeSessionStreams, closeUserStreams, closeSessionStreamsForGuild, switchSessionGuild, closeStreamsOutsideGuild, wrapStoreDestroy,
  getSessionStreamStats, resetSessionStreamsForTests, TOMBSTONE_TTL_MS, SESSION_GUILD_TTL_MS, MAX_TRACKED_ENTRIES, CONTEXT_CHANGED_FRAME,
} from './sessionStreams';
import { SESSION_IDLE_MS, SESSION_ABSOLUTE_MAX_MS } from './sessionLifetime';

/** A response stand-in: an emitter whose `end()` records the call and emits `close`, as a real one does. */
function fakeRes(): Response & { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> } {
  const res = new EventEmitter() as unknown as Response & { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
  res.write = vi.fn(() => true);
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

/** A request for a signed-in session whose current guild is `guildId`. */
function guildReq(sessionID: string, guildId: string | null, discordId = '42'): Request {
  return fakeReq(sessionID, discordId, 0, { user: { discordId, currentGuildId: guildId } });
}

describe('the context-changed frame', () => {
  /** Asserts the frame was written exactly once and before the stream ended. */
  function expectFrameThenEnd(res: ReturnType<typeof fakeRes>): void {
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledWith(CONTEXT_CHANGED_FRAME);
    expect(res.write.mock.invocationCallOrder[0]).toBeLessThan(res.end.mock.invocationCallOrder[0]!);
  }

  it('is a named SSE event with an empty payload', () => {
    expect(CONTEXT_CHANGED_FRAME).toBe('event: context-changed\ndata: {}\n\n');
  });

  it('is written before the stream ends when the session is destroyed', () => {
    const res = fakeRes();
    registerSessionStream(fakeReq('s1'), res, 'status');
    closeSessionStreams('s1');
    expectFrameThenEnd(res);
  });

  it('is written when the user signs out their other sessions', () => {
    const res = fakeRes();
    registerSessionStream(fakeReq('s1', '42', 0), res, 'events');
    closeUserStreams('42', 1);
    expectFrameThenEnd(res);
  });

  it('is written when the session switches guild, to the old guild\'s status stream only', () => {
    const old = fakeRes();
    const events = fakeRes();
    registerSessionStream(fakeReq('s1', '42', undefined, { user: { discordId: '42', currentGuildId: 'g1' } }), old, 'status');
    registerSessionStream(fakeReq('s1'), events, 'events');
    switchSessionGuild('s1', 'g2');
    expectFrameThenEnd(old);
    expect(events.write).not.toHaveBeenCalled();
  });

  it('is written when the session loses a guild', () => {
    const res = fakeRes();
    registerSessionStream(fakeReq('s1', '42', undefined, { user: { discordId: '42', currentGuildId: 'g1' } }), res, 'status');
    closeSessionStreamsForGuild('s1', 'g1');
    expectFrameThenEnd(res);
  });

  it('is not written when the session reaches its end time: the reload would be a page load that renews a session that may still be alive', () => {
    vi.useFakeTimers();
    try {
      const res = fakeRes();
      registerSessionStream(fakeReq('s1', '42', 0, { lastSeenAt: Date.now(), loginAt: Date.now() }), res, 'status');
      vi.advanceTimersByTime(SESSION_IDLE_MS + 1000);
      expect(res.end).toHaveBeenCalledTimes(1);
      expect(res.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not written to a stream refused at attach, which has no page state to refresh', () => {
    closeSessionStreams('s1');
    const late = fakeRes();
    registerSessionStream(fakeReq('s1'), late, 'status');
    expect(late.write).not.toHaveBeenCalled();
    expect(late.end).toHaveBeenCalledTimes(1);
  });

  it('is not written to a response that has already ended or been destroyed, and the stream still closes', () => {
    const ended = fakeRes();
    const destroyed = fakeRes();
    registerSessionStream(fakeReq('s1'), ended, 'status');
    registerSessionStream(fakeReq('s1'), destroyed, 'events');
    Object.assign(ended, { writableEnded: true });
    Object.assign(destroyed, { destroyed: true });
    closeSessionStreams('s1');
    expect(ended.write).not.toHaveBeenCalled();
    expect(destroyed.write).not.toHaveBeenCalled();
    expect(ended.end).toHaveBeenCalledTimes(1);
    expect(destroyed.end).toHaveBeenCalledTimes(1);
  });

  it('still ends the stream, and keeps closing the rest, when writing the frame throws', () => {
    const bad = fakeRes();
    const good = fakeRes();
    bad.write.mockImplementation(() => { throw new Error('broken pipe'); });
    registerSessionStream(fakeReq('s1'), bad, 'status');
    registerSessionStream(fakeReq('s1'), good, 'events');
    closeSessionStreams('s1');
    expect(mockLog.warn).toHaveBeenCalled();
    expect(bad.end).toHaveBeenCalledTimes(1);
    expect(good.end).toHaveBeenCalledTimes(1);
    expect(getSessionStreamStats().streams).toBe(0);
  });
});

describe('switchSessionGuild (the session picked another guild)', () => {
  it('closes the session\'s status streams for the old guild and keeps the new guild\'s, the events stream and other sessions', () => {
    const oldGuild = fakeRes();
    const newGuild = fakeRes();
    const events = fakeRes();
    const otherSession = fakeRes();
    registerSessionStream(guildReq('s1', 'gX'), oldGuild, 'status');
    registerSessionStream(guildReq('s1', 'gY'), newGuild, 'status');
    registerSessionStream(guildReq('s1', 'gX'), events, 'events');
    registerSessionStream(guildReq('s2', 'gX'), otherSession, 'status');

    switchSessionGuild('s1', 'gY');

    expect(oldGuild.end).toHaveBeenCalledTimes(1);
    expect(newGuild.end).not.toHaveBeenCalled();
    expect(events.end).not.toHaveBeenCalled(); // /dashboard/events is per streamer, not per guild
    expect(otherSession.end).not.toHaveBeenCalled();
  });

  it('refuses a status stream that registers afterwards under the old guild (its request loaded the session before the switch)', () => {
    switchSessionGuild('s1', 'gY');
    const late = fakeRes();

    expect(registerSessionStream(guildReq('s1', 'gX'), late, 'status')).toBe(false);
    expect(late.end).toHaveBeenCalledTimes(1);
    expect(registerSessionStream(guildReq('s1', 'gY'), fakeRes(), 'status')).toBe(true);
    expect(registerSessionStream(guildReq('s2', 'gX'), fakeRes(), 'status')).toBe(true);
    expect(registerSessionStream(guildReq('s1', 'gX'), fakeRes(), 'events')).toBe(true);
  });

  it('keeps the latest guild when the session switches again', () => {
    switchSessionGuild('s1', 'gY');
    switchSessionGuild('s1', 'gX');

    expect(registerSessionStream(guildReq('s1', 'gX'), fakeRes(), 'status')).toBe(true);
    expect(registerSessionStream(guildReq('s1', 'gY'), fakeRes(), 'status')).toBe(false);
  });

  it('forgets the switch after the TTL, and caps what it remembers', () => {
    vi.useFakeTimers();
    try {
      switchSessionGuild('s1', 'gY');
      vi.advanceTimersByTime(SESSION_GUILD_TTL_MS - 1);
      expect(registerSessionStream(guildReq('s1', 'gX'), fakeRes(), 'status')).toBe(false);
      vi.advanceTimersByTime(2);
      expect(registerSessionStream(guildReq('s1', 'gX'), fakeRes(), 'status')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    for (let i = 0; i < MAX_TRACKED_ENTRIES + 5; i++) switchSessionGuild(`sid-${i}`, 'gY');
    expect(getSessionStreamStats().sessionGuilds).toBe(MAX_TRACKED_ENTRIES);
  });

  it('closes every status stream the session holds under the old guild, and detaches each request\'s session so none saves it back', () => {
    const [a, b] = [fakeRes(), fakeRes()];
    const [reqA, reqB] = [guildReq('s1', 'gX'), guildReq('s1', 'gX')];
    registerSessionStream(reqA, a, 'status');
    registerSessionStream(reqB, b, 'status');

    switchSessionGuild('s1', 'gY');

    expect(a.end).toHaveBeenCalledTimes(1);
    expect(b.end).toHaveBeenCalledTimes(1);
    expect(reqA.session).toBeUndefined();
    expect(reqB.session).toBeUndefined();
  });

  it('closes nothing, and refuses nothing, for a status stream with no guild recorded', () => {
    switchSessionGuild('s1', 'gY');
    const res = fakeRes();

    expect(registerSessionStream(guildReq('s1', null), res, 'status')).toBe(true);
    expect(res.end).not.toHaveBeenCalled();
  });
});

describe('switchSessionGuild with closeNow false, then closeStreamsOutsideGuild', () => {
  it('records the switch at once, so an old-guild stream is refused, and closes the old streams only when asked', () => {
    const old = fakeRes();
    registerSessionStream(guildReq('s1', 'g1'), old, 'status');

    switchSessionGuild('s1', 'g2', false);
    expect(old.end).not.toHaveBeenCalled();
    expect(registerSessionStream(guildReq('s1', 'g1'), fakeRes(), 'status')).toBe(false);

    closeStreamsOutsideGuild('s1', 'g2');
    expect(old.write).toHaveBeenCalledWith(CONTEXT_CHANGED_FRAME);
    expect(old.end).toHaveBeenCalledTimes(1);
  });

  it('leaves the new guild\'s streams, the events stream and other sessions open', () => {
    const current = fakeRes();
    const events = fakeRes();
    const other = fakeRes();
    registerSessionStream(guildReq('s1', 'g2'), current, 'status');
    registerSessionStream(guildReq('s1', 'g1'), events, 'events');
    registerSessionStream(guildReq('s2', 'g1'), other, 'status');

    closeStreamsOutsideGuild('s1', 'g2');

    expect(current.end).not.toHaveBeenCalled();
    expect(events.end).not.toHaveBeenCalled();
    expect(other.end).not.toHaveBeenCalled();
  });
});

describe('closeSessionStreamsForGuild (the session lost a guild)', () => {
  it('closes only that session\'s status streams for that guild', () => {
    const lost = fakeRes();
    const kept = fakeRes();
    const events = fakeRes();
    const otherSession = fakeRes();
    registerSessionStream(guildReq('s1', 'gX'), lost, 'status');
    registerSessionStream(guildReq('s1', 'gY'), kept, 'status');
    registerSessionStream(guildReq('s1', 'gX'), events, 'events');
    registerSessionStream(guildReq('s2', 'gX'), otherSession, 'status');

    closeSessionStreamsForGuild('s1', 'gX');

    expect(lost.end).toHaveBeenCalledTimes(1);
    expect(kept.end).not.toHaveBeenCalled();
    expect(events.end).not.toHaveBeenCalled();
    expect(otherSession.end).not.toHaveBeenCalled();
    expect(getSessionStreamStats().streams).toBe(3);
  });

  it('detaches the closed stream\'s session, and leaves the others\' sessions attached', () => {
    const [lostReq, keptReq] = [guildReq('s1', 'gX'), guildReq('s1', 'gY')];
    registerSessionStream(lostReq, fakeRes(), 'status');
    registerSessionStream(keptReq, fakeRes(), 'status');

    closeSessionStreamsForGuild('s1', 'gX');

    expect(lostReq.session).toBeUndefined();
    expect(keptReq.session).toBeDefined();
  });

  it('voids a recorded switch to the lost guild, so a stream for the guild auto-picked next is not refused', () => {
    switchSessionGuild('s1', 'gX');

    closeSessionStreamsForGuild('s1', 'gX'); // gX revoked: requireGuildContext drops it, then auto-picks the only guild left, gY

    expect(registerSessionStream(guildReq('s1', 'gY'), fakeRes(), 'status')).toBe(true);
    expect(getSessionStreamStats().sessionGuilds).toBe(0);
  });

  it('keeps a recorded switch to a different guild than the one lost', () => {
    switchSessionGuild('s1', 'gY');

    closeSessionStreamsForGuild('s1', 'gX');

    expect(registerSessionStream(guildReq('s1', 'gX'), fakeRes(), 'status')).toBe(false);
  });

  it('does nothing for a session or guild with no open stream', () => {
    expect(() => closeSessionStreamsForGuild('nope', 'gX')).not.toThrow();
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

  it('has already written the frame and ended the stream when the real destroy never calls back: no barrier waits for the store (#1164, #1193)', () => {
    const res = fakeRes();
    res.end = vi.fn(() => { res.emit('close'); return res; });
    registerSessionStream(fakeReq('s1'), res, 'status');
    // A store whose destroy never invokes its callback (a hung write): the wrapper must not hold the close back for it.
    const destroy = vi.fn();
    const store = { destroy } as unknown as session.Store;
    wrapStoreDestroy(store);
    const cb = vi.fn();

    (store.destroy as unknown as (sid: string, cb: () => void) => unknown)('s1', cb);

    expect(res.write).toHaveBeenCalledWith(CONTEXT_CHANGED_FRAME);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith('s1', cb);
    expect(cb).not.toHaveBeenCalled();
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
    app.set('trust proxy', 1);
    const results: { sid?: string } = {};
    // As in production: a secure, httpOnly cookie behind the proxy (the requests below send X-Forwarded-Proto: https).
    app.use(session({ secret: 'x'.repeat(32), resave: false, saveUninitialized: false, store, cookie: { secure: true, httpOnly: true, sameSite: 'lax' } }));
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
    const https = { 'X-Forwarded-Proto': 'https' };
    const cookie = (await supertest(app).get('/login').set(https)).headers['set-cookie']?.[0]?.split(';')[0] ?? '';
    /** A GET carrying the signed-in session's cookie. */
    const get = (path: string) => supertest(app).get(path).set({ ...https, Cookie: cookie });
    return { get, results };
  }

  it('closes the session\'s stream on req.session.destroy and refuses a later attach under that ID', async () => {
    const { get, results } = await boot();
    await get('/stream');
    const stream = (globalThis as unknown as { lastStream: { end: ReturnType<typeof vi.fn> } }).lastStream;

    await get('/destroy');

    expect(stream.end).toHaveBeenCalledTimes(1);
    expect(results.sid).toBeTruthy();
    expect(registerSessionStream(fakeReq(results.sid as string), fakeRes(), 'status')).toBe(false);
  });

  it('closes the old ID\'s stream on regenerate (account switch) and leaves other sessions alone', async () => {
    const { get } = await boot();
    await get('/stream');
    const stream = (globalThis as unknown as { lastStream: { end: ReturnType<typeof vi.fn> } }).lastStream;
    const otherStream = fakeRes();
    registerSessionStream(fakeReq('another-session'), otherStream, 'status');

    await get('/regenerate');

    expect(stream.end).toHaveBeenCalledTimes(1);
    expect(otherStream.end).not.toHaveBeenCalled();
  });
});

describe('a closed stream never writes its session back (a late save would undo the destroy)', () => {
  /** A MemoryStore whose `set` lands one tick late, like a pooled MySQL write finishing after a later DELETE. */
  class LateSetStore extends session.MemoryStore {
    sets = 0;

    set(sessionId: string, sess: session.SessionData, callback?: (err?: unknown) => void): void {
      this.sets++;
      setImmediate(() => super.set(sessionId, sess, callback));
    }
  }

  it('leaves no session row behind after the destroy, even though the stream\'s own session was modified', async () => {
    const store = new LateSetStore();
    wrapStoreDestroy(store);
    const app = express();
    app.set('trust proxy', 1);
    app.use(session({ secret: 'x'.repeat(32), resave: false, saveUninitialized: false, store, cookie: { secure: true, httpOnly: true, sameSite: 'lax' } }));
    let sid = '';
    app.get('/login', (req, res) => {
      req.session.user = { discordId: '42', discordName: 'u', discordAvatar: null, isOwner: false, accessLevel: 0, currentGuildId: 'g1', guilds: [] };
      sid = req.sessionID;
      res.sendStatus(204);
    });
    // An open SSE stream on a request whose session changed (as requireGuildContext can change it).
    app.get('/stream', (req, res) => {
      req.session.user!.accessLevel = 3;
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
      res.write(': connected\n\n');
      registerSessionStream(req, res, 'status');
    });
    app.get('/destroy', (req, res) => { req.session.destroy(() => res.sendStatus(204)); });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const https = { 'X-Forwarded-Proto': 'https' };
    try {
      const supertest = (await import('supertest')).default;
      const cookie = (await supertest(server).get('/login').set(https)).headers['set-cookie']?.[0]?.split(';')[0] ?? '';
      await new Promise((resolve) => setImmediate(resolve)); // let the login's own (late) save land
      expect(await new Promise((resolve) => store.get(sid, (_e, row) => resolve(row)))).toBeTruthy();
      const setsBefore = store.sets;
      const closed = new Promise<void>((resolve) => {
        http.get({ port, host: '127.0.0.1', path: '/stream', headers: { ...https, Cookie: cookie } }, (res) => {
          res.on('data', () => {});
          res.on('end', resolve);
          res.on('close', resolve);
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 50)); // the stream is open and registered

      await supertest(server).get('/destroy').set({ ...https, Cookie: cookie });
      await closed;
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

      expect(await new Promise((resolve) => store.get(sid, (_e, row) => resolve(row)))).toBeFalsy();
      expect(store.sets).toBe(setsBefore); // the closing stream did not try to save its session
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
