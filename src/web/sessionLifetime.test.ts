import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import supertest from 'supertest';
import {
  enforceSessionLifetime, isPageLoad, isSessionPastLifetime, startSessionLifetime,
  SESSION_ABSOLUTE_MAX_MS, SESSION_IDLE_MS, SESSION_RENEW_INTERVAL_MS,
} from './sessionLifetime';
import { isSessionStoreBusyError } from './rateLimits';

const NOW = Date.UTC(2026, 10, 13, 12);
const USER = { discordId: '1', discordName: 'a', discordAvatar: null, isOwner: false, accessLevel: 0, currentGuildId: null, guilds: [] };

/** A request stub with the given fetch-metadata headers and session data. */
function makeReq(headers: Record<string, string>, sessionData: Record<string, unknown>, regenerate = vi.fn((cb: (e?: unknown) => void) => cb())) {
  return { get: (name: string) => headers[name.toLowerCase()], session: { ...sessionData, regenerate } } as any;
}

const NAVIGATE = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const FETCH = { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isPageLoad', () => {
  it.each([
    ['a top-level navigation', NAVIGATE, true],
    ['a navigation without Sec-Fetch-Dest', { 'sec-fetch-mode': 'navigate' }, true],
    ['an iframe navigation', { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }, false],
    ['a fetch()', FETCH, false],
    ['an EventSource', { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, false],
    ['a browser without fetch metadata', {}, false],
  ])('%s → %s', (_label, headers, expected) => {
    expect(isPageLoad(makeReq(headers, {}))).toBe(expected);
  });
});

describe('isSessionPastLifetime', () => {
  it('ends a session past the absolute cap however recently it was used', () => {
    expect(isSessionPastLifetime({ loginAt: NOW - SESSION_ABSOLUTE_MAX_MS - 1, lastSeenAt: NOW }, NOW)).toBe(true);
    expect(isSessionPastLifetime({ loginAt: NOW - SESSION_ABSOLUTE_MAX_MS, lastSeenAt: NOW }, NOW)).toBe(false);
  });

  it('ends a session idle for longer than the idle timeout', () => {
    expect(isSessionPastLifetime({ loginAt: NOW - 1000, lastSeenAt: NOW - SESSION_IDLE_MS - 1 }, NOW)).toBe(true);
    expect(isSessionPastLifetime({ loginAt: NOW - 1000, lastSeenAt: NOW - SESSION_IDLE_MS }, NOW)).toBe(false);
  });

  it('leaves a session from before the change (no times recorded) to its cookie', () => {
    expect(isSessionPastLifetime({}, NOW)).toBe(false);
  });
});

describe('startSessionLifetime', () => {
  it('records the login as both the start and the last renewal', () => {
    const data: Record<string, unknown> = {};
    startSessionLifetime(data, NOW);
    expect(data).toEqual({ loginAt: NOW, lastSeenAt: NOW });
  });
});

describe('enforceSessionLifetime', () => {
  it('passes a request without a logged-in session straight through', async () => {
    const req = makeReq(NAVIGATE, {});
    const next = vi.fn();
    await enforceSessionLifetime(req, {} as any, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.session.lastSeenAt).toBeUndefined();
  });

  it('renews a session on a page load', async () => {
    const req = makeReq(NAVIGATE, { user: USER, loginAt: NOW - 3_600_000, lastSeenAt: NOW - SESSION_RENEW_INTERVAL_MS });
    await enforceSessionLifetime(req, {} as any, vi.fn());
    expect(req.session.lastSeenAt).toBe(NOW);
    expect(req.session.loginAt).toBe(NOW - 3_600_000);
  });

  it('renews at most once per renewal interval', async () => {
    const lastSeenAt = NOW - SESSION_RENEW_INTERVAL_MS + 1;
    const req = makeReq(NAVIGATE, { user: USER, loginAt: NOW - 3_600_000, lastSeenAt });
    await enforceSessionLifetime(req, {} as any, vi.fn());
    expect(req.session.lastSeenAt).toBe(lastSeenAt);
  });

  it('does not renew on a background request', async () => {
    const req = makeReq(FETCH, { user: USER, loginAt: NOW - 3_600_000, lastSeenAt: NOW - 3_600_000 });
    const next = vi.fn();
    await enforceSessionLifetime(req, {} as any, next);
    expect(req.session.lastSeenAt).toBe(NOW - 3_600_000);
    expect(next).toHaveBeenCalledWith();
  });

  it('gives a session from before the change its login time on its first page load', async () => {
    const req = makeReq(NAVIGATE, { user: USER });
    await enforceSessionLifetime(req, {} as any, vi.fn());
    expect(req.session).toMatchObject({ loginAt: NOW, lastSeenAt: NOW });
  });

  it('leaves a session from before the change alone on a background request', async () => {
    const req = makeReq(FETCH, { user: USER });
    await enforceSessionLifetime(req, {} as any, vi.fn());
    expect(req.session.loginAt).toBeUndefined();
  });

  it('ends a session past its lifetime and carries on logged out', async () => {
    const req = makeReq(NAVIGATE, { user: USER, loginAt: NOW - SESSION_ABSOLUTE_MAX_MS - 1, lastSeenAt: NOW });
    const next = vi.fn();
    await enforceSessionLifetime(req, {} as any, next);
    expect(req.session.regenerate).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('passes on a store failure while ending a session, marked as a session-store error', async () => {
    const err = new Error('Queue limit reached.');
    const req = makeReq(FETCH, { user: USER, loginAt: NOW, lastSeenAt: NOW - SESSION_IDLE_MS - 1 }, vi.fn((cb) => cb(err)));
    const next = vi.fn();
    await enforceSessionLifetime(req, {} as any, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(isSessionStoreBusyError(err)).toBe(true);
  });
});

describe('with express-session', () => {
  /** An app on a memory store: `/login` logs in, `/page` and `/api` report whether a user is logged in. */
  function buildApp() {
    const store = new session.MemoryStore();
    const app = express();
    // Secure cookie as in production: requests come "through the proxy" over HTTPS.
    app.set('trust proxy', 1);
    app.use(session({
      secret: 'x'.repeat(32), resave: false, saveUninitialized: false, store,
      cookie: { secure: true, httpOnly: true, sameSite: 'lax', maxAge: SESSION_IDLE_MS },
    }));
    app.use(enforceSessionLifetime);
    app.get('/login', (req, res) => {
      req.session.user = USER as any;
      startSessionLifetime(req.session, Date.now());
      res.send('ok');
    });
    app.get(['/page', '/api'], (req, res) => {
      res.status(req.session.user ? 200 : 401).send(req.session.user ? 'in' : 'out');
    });
    return { app, store };
  }

  /**
   * A client that keeps the session cookie by hand (supertest's agent won't send a `Secure` cookie
   * over plain HTTP) and sends each request as if over HTTPS through the proxy.
   */
  function makeClient(app: express.Express) {
    let cookie = '';
    const get = async (path: string, headers: Record<string, string> = {}) => {
      const res = await supertest(app).get(path).set({ ...headers, 'X-Forwarded-Proto': 'https', Cookie: cookie });
      const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0];
      if (setCookie) cookie = setCookie.split(';')[0]!;
      return res;
    };
    return { get };
  }

  /** The `Expires` date of a response's session cookie, or undefined if none was set. */
  function cookieExpiry(res: supertest.Response): number | undefined {
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0];
    const match = cookie && /Expires=([^;]+)/.exec(cookie);
    return match ? Date.parse(match[1]!) : undefined;
  }

  it('re-sends the cookie with a fresh expiry on a page load, but not on a background request', async () => {
    const { app } = buildApp();
    const agent = makeClient(app);
    const login = await agent.get('/login');
    expect(cookieExpiry(login)).toBe(Math.floor((NOW + SESSION_IDLE_MS) / 1000) * 1000);

    vi.setSystemTime(NOW + 6 * 3_600_000);
    const background = await agent.get('/api', FETCH);
    expect(background.status).toBe(200);
    expect(cookieExpiry(background)).toBeUndefined();

    const page = await agent.get('/page', NAVIGATE);
    expect(page.status).toBe(200);
    expect(cookieExpiry(page)).toBe(Math.floor((NOW + 6 * 3_600_000 + SESSION_IDLE_MS) / 1000) * 1000);
  });

  it('logs the user out once the absolute cap has passed, even with daily page loads', async () => {
    const { app } = buildApp();
    const agent = makeClient(app);
    await agent.get('/login');
    for (let day = 1; day <= 7; day++) {
      vi.setSystemTime(NOW + day * 23 * 3_600_000);
      expect((await agent.get('/page', NAVIGATE)).status).toBe(200);
    }
    vi.setSystemTime(NOW + SESSION_ABSOLUTE_MAX_MS + 1);
    expect((await agent.get('/api', FETCH)).status).toBe(401);
    expect((await agent.get('/page', NAVIGATE)).status).toBe(401);
  });
});
