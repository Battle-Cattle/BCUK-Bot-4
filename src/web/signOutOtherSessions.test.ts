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

/**
 * An app with a test-only sign-in route (copying the row's generation as `establishDashboardSession`
 * does), a protected page, a protected `/api` route, and the sign-out action.
 */
function buildApp(): express.Express {
  const app = express();
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false, store: new session.MemoryStore() }));
  app.post('/login', (req, res) => {
    req.session.user = { discordId: '42', discordName: 'Alice', discordAvatar: null, isOwner: false, accessLevel: 0, currentGuildId: 'g1', guilds: [] };
    req.session.sessionGeneration = row.session_generation;
    res.sendStatus(204);
  });
  app.get('/page', requireAuth, (_req, res) => { res.send('ok'); });
  app.get('/api/thing', requireAuthJson, (_req, res) => { res.json({ ok: true }); });
  app.post('/sign-out-others', requireAuth, async (req, res) => {
    await signOutOtherSessions(req);
    res.sendStatus(204);
  });
  return app;
}

beforeEach(() => {
  row.session_generation = 0;
});

describe('sign out other sessions (#1058)', () => {
  it('ends the other sessions (redirect, or 401 under /api) and keeps the one that asked', async () => {
    const app = buildApp();
    const here = supertest.agent(app);
    const otherBrowser = supertest.agent(app);
    const otherScript = supertest.agent(app);
    for (const agent of [here, otherBrowser, otherScript]) await agent.post('/login').expect(204);
    await otherBrowser.get('/page').expect(200);

    await here.post('/sign-out-others').expect(204);

    await here.get('/page').expect(200, 'ok');
    await here.get('/api/thing').expect(200);
    const page = await otherBrowser.get('/page');
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/auth/login');
    const api = await otherScript.get('/api/thing');
    expect(api.status).toBe(401);
    expect(api.body).toEqual({ ok: false, error: 'unauthenticated' });
  });

  it('re-issues the asking session under a new cookie, so a copy of its old cookie is signed out', async () => {
    const app = buildApp();
    const login = await supertest(app).post('/login').expect(204);
    const oldCookie = login.headers['set-cookie']![0]!.split(';')[0]!;

    const signOut = await supertest(app).post('/sign-out-others').set('Cookie', oldCookie).expect(204);
    const newCookie = signOut.headers['set-cookie']![0]!.split(';')[0]!;
    expect(newCookie).not.toBe(oldCookie);

    await supertest(app).get('/page').set('Cookie', newCookie).expect(200);
    const stale = await supertest(app).get('/page').set('Cookie', oldCookie);
    expect(stale.status).toBe(302);
    expect(stale.headers.location).toBe('/auth/login');
  });
});

