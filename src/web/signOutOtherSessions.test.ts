import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../test-utils/accessLevelMock';

// "Sign out other sessions" (#1058) end to end: the real requireAuth/requireAuthJson and
// signOutOtherSessions against a real express-session, with the user row held in memory.
const row = { discord_id: '42', discord_name: 'Alice', is_twitch_bot_enabled: false, twitch_name: null, is_owner: false, session_generation: 0 };

vi.mock('../db', () => ({
  findUser: vi.fn(async (id: string) => (id === row.discord_id ? { ...row } : null)),
  getGuildsForMember: vi.fn(async () => [{ guild_id: 'g1', name: 'Guild', voice_channel_id: null, access_level: 0 }]),
  getAllGuilds: vi.fn(async () => []),
  getEffectiveAccessLevelForUser: vi.fn(async () => 0),
  bumpSessionGeneration: vi.fn(async () => { row.session_generation += 1; return row.session_generation; }),
  updateDiscordName: vi.fn(),
  findKeyByHash: vi.fn(),
  findDiscordIdByTokenHash: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

import express from 'express';
import session from 'express-session';
import supertest from 'supertest';
import { requireAuth, requireAuthJson } from './middleware';
import { signOutOtherSessions } from './loginSession';
import { csrfProtection } from './csrf';

/**
 * An app set up as in production (secure cookie behind the proxy, CSRF-checked writes) with a
 * test-only sign-in route that copies the row's generation as `establishDashboardSession` does and
 * answers the session's CSRF token, a protected page, a protected `/api` route, and the sign-out.
 */
function buildApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(session({
    secret: 'x'.repeat(32), resave: false, saveUninitialized: false, store: new session.MemoryStore(),
    cookie: { secure: true, httpOnly: true, sameSite: 'lax' },
  }));
  app.use(csrfProtection);
  app.get('/login', (req, res) => {
    req.session.user = { discordId: '42', discordName: 'Alice', discordAvatar: null, isOwner: false, accessLevel: 0, currentGuildId: 'g1', guilds: [] };
    req.session.sessionGeneration = row.session_generation;
    res.send(req.csrfToken());
  });
  app.get('/page', requireAuth, (_req, res) => { res.send('ok'); });
  app.get('/api/thing', requireAuthJson, (_req, res) => { res.json({ ok: true }); });
  app.post('/sign-out-others', requireAuth, async (req, res) => {
    await signOutOtherSessions(req);
    res.sendStatus(204);
  });
  app.use((err: { code?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err.code === 'EBADCSRFTOKEN') res.sendStatus(403);
    else next(err);
  });
  return app;
}

/** A browser: keeps its session cookie by hand (supertest's agent won't send a `Secure` cookie over plain HTTP). */
class Client {
  cookie = '';
  csrf = '';

  constructor(private readonly app: express.Express) {}

  /** Records a `Set-Cookie` from the response, if any. */
  private keep(res: supertest.Response): supertest.Response {
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0];
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    return res;
  }

  async login(): Promise<void> {
    const res = await this.get('/login');
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
    this.csrf = res.text;
  }

  async get(path: string): Promise<supertest.Response> {
    return this.keep(await supertest(this.app).get(path).set({ 'X-Forwarded-Proto': 'https', Cookie: this.cookie }));
  }

  async signOutOthers(): Promise<supertest.Response> {
    return this.keep(await supertest(this.app).post('/sign-out-others')
      .set({ 'X-Forwarded-Proto': 'https', Cookie: this.cookie, 'X-CSRF-Token': this.csrf }));
  }
}

beforeEach(() => {
  row.session_generation = 0;
});

describe('sign out other sessions (#1058)', () => {
  it('ends the other sessions (redirect, or 401 under /api) and keeps the one that asked', async () => {
    const app = buildApp();
    const [here, otherBrowser, otherScript] = [new Client(app), new Client(app), new Client(app)];
    for (const client of [here, otherBrowser, otherScript]) await client.login();
    expect((await otherBrowser.get('/page')).status).toBe(200);

    expect((await here.signOutOthers()).status).toBe(204);

    expect((await here.get('/page')).text).toBe('ok');
    expect((await here.get('/api/thing')).status).toBe(200);
    const page = await otherBrowser.get('/page');
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/auth/login');
    const api = await otherScript.get('/api/thing');
    expect(api.status).toBe(401);
    expect(api.body).toEqual({ ok: false, error: 'unauthenticated' });
  });

  it('re-issues the asking session under a new cookie, so a copy of its old cookie is signed out', async () => {
    const app = buildApp();
    const here = new Client(app);
    await here.login();
    const copy = new Client(app);
    copy.cookie = here.cookie;

    expect((await here.signOutOthers()).status).toBe(204);
    expect(here.cookie).not.toBe(copy.cookie);

    expect((await here.get('/page')).status).toBe(200);
    const stale = await copy.get('/page');
    expect(stale.status).toBe(302);
    expect(stale.headers.location).toBe('/auth/login');
  });

  it('refuses the sign-out without the session\'s CSRF token', async () => {
    const app = buildApp();
    const here = new Client(app);
    await here.login();
    here.csrf = 'wrong';
    expect((await here.signOutOthers()).status).toBe(403);
    expect(row.session_generation).toBe(0);
  });
});
