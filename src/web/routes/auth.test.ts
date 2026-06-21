import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/config', () => ({
  DISCORD_CLIENT_ID: 'client_id',
  DISCORD_CLIENT_SECRET: 'client_secret',
  DISCORD_CALLBACK_URL: 'http://localhost/auth/discord/callback',
}));
vi.mock('../../db', () => ({
  findUser: vi.fn().mockResolvedValue(null),
  updateDiscordName: vi.fn().mockResolvedValue(undefined),
  getAllGuilds: vi.fn().mockResolvedValue([]),
  getGuildsForMember: vi.fn().mockResolvedValue([]),
  getEffectiveAccessLevel: vi.fn().mockResolvedValue(0),
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
}));
vi.mock('../../discord/discordBot', () => ({
  fetchMemberDisplayName: vi.fn().mockResolvedValue(null),
}));
vi.mock('../csrf', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import express from 'express';
import supertest from 'supertest';
import router from './auth';
import {
  findUser,
  updateDiscordName,
  getAllGuilds,
  getGuildsForMember,
  getEffectiveAccessLevel,
  AccessLevel,
} from '../../db';
import { fetchMemberDisplayName } from '../../discord/discordBot';

function buildApp(sessionOverrides: Record<string, unknown> = {}, captureSession?: (session: any) => void) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req: any, _res: any, next: any) => {
    req.session = {
      oauthState: undefined,
      user: undefined,
      destroy: vi.fn((cb: () => void) => cb()),
      regenerate: vi.fn((cb: (err: null) => void) => cb(null)),
      save: vi.fn((cb: (err: null) => void) => {
        captureSession?.(req.session);
        cb(null);
      }),
      ...sessionOverrides,
    };
    next();
  });
  app.use((req: any, res: any, next: any) => {
    res.render = (view: string, locals: unknown) =>
      res.status((res as any).statusCode || 200).json({ view, locals });
    next();
  });
  app.use(router);
  return app;
}

function mockFetch(responses: { ok: boolean; json?: () => Promise<unknown>; status?: number }[]) {
  let callIndex = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    const r = responses[callIndex++];
    return Promise.resolve({ ok: r.ok, status: r.status ?? 200, json: r.json ?? (() => Promise.resolve({})) } as Response);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findUser).mockResolvedValue(null);
  vi.mocked(fetchMemberDisplayName).mockResolvedValue(null);
  vi.mocked(getAllGuilds).mockResolvedValue([]);
  vi.mocked(getGuildsForMember).mockResolvedValue([]);
  vi.mocked(getEffectiveAccessLevel).mockResolvedValue(0);
});

// ─── GET /discord ─────────────────────────────────────────────────────────────

describe('GET /discord', () => {
  it('redirects to Discord OAuth URL', async () => {
    const res = await supertest(buildApp()).get('/discord');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('discord.com/oauth2/authorize');
  });

  it('includes client_id and state in the redirect URL', async () => {
    const res = await supertest(buildApp()).get('/discord');
    expect(res.headers.location).toContain('client_id=client_id');
    expect(res.headers.location).toContain('state=');
  });
});

// ─── GET /discord/callback ────────────────────────────────────────────────────

describe('GET /discord/callback', () => {
  it('renders error 400 when state does not match session', async () => {
    const res = await supertest(buildApp({ oauthState: { value: 'expected', expiresAt: Date.now() + 60_000 } }))
      .get('/discord/callback?code=abc&state=wrong');
    expect(res.status).toBe(400);
    expect((res.body as any).view).toBe('error');
  });

  it('renders error 400 when code is missing', async () => {
    const res = await supertest(buildApp({ oauthState: { value: 'abc', expiresAt: Date.now() + 60_000 } }))
      .get('/discord/callback?state=abc');
    expect(res.status).toBe(400);
  });

  it('renders error 400 when OAuth state has expired', async () => {
    const res = await supertest(buildApp({ oauthState: { value: 'state123', expiresAt: Date.now() - 1 } }))
      .get('/discord/callback?code=code&state=state123');
    expect(res.status).toBe(400);
    expect((res.body as any).view).toBe('error');
  });

  it('renders error 500 when token exchange fails', async () => {
    mockFetch([{ ok: false, status: 400 }]);
    const res = await supertest(buildApp({ oauthState: { value: 'state123', expiresAt: Date.now() + 60_000 } }))
      .get('/discord/callback?code=code&state=state123');
    expect(res.status).toBe(500);
    expect((res.body as any).view).toBe('error');
  });

  it('renders error 500 when profile fetch fails', async () => {
    mockFetch([
      { ok: true, json: () => Promise.resolve({ access_token: 'tok' }) },
      { ok: false, status: 401 },
    ]);
    const res = await supertest(buildApp({ oauthState: { value: 'state123', expiresAt: Date.now() + 60_000 } }))
      .get('/discord/callback?code=code&state=state123');
    expect(res.status).toBe(500);
  });

  it('renders error 403 when user is not in the whitelist', async () => {
    mockFetch([
      { ok: true, json: () => Promise.resolve({ access_token: 'tok' }) },
      { ok: true, json: () => Promise.resolve({ id: '999', username: 'stranger', avatar: null }) },
    ]);
    const res = await supertest(buildApp({ oauthState: { value: 'state123', expiresAt: Date.now() + 60_000 } }))
      .get('/discord/callback?code=code&state=state123');
    expect(res.status).toBe(403);
  });

  it('renders error 403 when the whitelisted user belongs to no guild', async () => {
    mockFetch([
      { ok: true, json: () => Promise.resolve({ access_token: 'tok' }) },
      { ok: true, json: () => Promise.resolve({ id: '111', username: 'alice', avatar: null }) },
    ]);
    vi.mocked(findUser).mockResolvedValue({ discord_id: '111', discord_name: 'alice', is_twitch_bot_enabled: false, twitch_name: null, access_level: AccessLevel.USER, is_owner: false } as any);
    vi.mocked(getGuildsForMember).mockResolvedValue([]);
    const res = await supertest(buildApp({ oauthState: { value: 'state123', expiresAt: Date.now() + 60_000 } }))
      .get('/discord/callback?code=code&state=state123');
    expect(res.status).toBe(403);
  });

  it('redirects to / on successful authentication', async () => {
    mockFetch([
      { ok: true, json: () => Promise.resolve({ access_token: 'tok' }) },
      { ok: true, json: () => Promise.resolve({ id: '111', username: 'alice', avatar: null }) },
    ]);
    vi.mocked(findUser).mockResolvedValue({ discord_id: '111', discord_name: 'alice', is_twitch_bot_enabled: false, twitch_name: null, access_level: AccessLevel.USER, is_owner: false } as any);
    vi.mocked(getGuildsForMember).mockResolvedValue([{ guild_id: '555', name: 'Guild', voice_channel_id: null }] as any);
    const res = await supertest(buildApp({ oauthState: { value: 'state123', expiresAt: Date.now() + 60_000 } }))
      .get('/discord/callback?code=code&state=state123');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('uses getAllGuilds (not getGuildsForMember) when the user is the bot owner', async () => {
    mockFetch([
      { ok: true, json: () => Promise.resolve({ access_token: 'tok' }) },
      { ok: true, json: () => Promise.resolve({ id: '111', username: 'alice', avatar: null }) },
    ]);
    vi.mocked(findUser).mockResolvedValue({ discord_id: '111', discord_name: 'alice', is_twitch_bot_enabled: false, twitch_name: null, access_level: AccessLevel.USER, is_owner: true } as any);
    vi.mocked(getAllGuilds).mockResolvedValue([
      { guild_id: '555', name: 'Guild', voice_channel_id: null },
      { guild_id: '556', name: 'Other Guild', voice_channel_id: null },
    ] as any);

    let capturedSession: any;
    const app = buildApp(
      { oauthState: { value: 'state123', expiresAt: Date.now() + 60_000 } },
      (session) => { capturedSession = session; },
    );
    const res = await supertest(app).get('/discord/callback?code=code&state=state123');

    expect(res.status).toBe(302);
    expect(getAllGuilds).toHaveBeenCalled();
    expect(getGuildsForMember).not.toHaveBeenCalled();
    expect(capturedSession.user).toMatchObject({
      currentGuildId: null,
      accessLevel: AccessLevel.USER,
    });
  });

  it('stores discordId, accessLevel and currentGuildId on the session after successful auth', async () => {
    mockFetch([
      { ok: true, json: () => Promise.resolve({ access_token: 'tok' }) },
      { ok: true, json: () => Promise.resolve({ id: '111', username: 'alice', avatar: null }) },
    ]);
    vi.mocked(findUser).mockResolvedValue({ discord_id: '111', discord_name: 'alice', is_twitch_bot_enabled: false, twitch_name: null, access_level: AccessLevel.USER, is_owner: false } as any);
    vi.mocked(getGuildsForMember).mockResolvedValue([{ guild_id: '555', name: 'Guild', voice_channel_id: null }] as any);
    vi.mocked(getEffectiveAccessLevel).mockResolvedValue(AccessLevel.MOD);

    let capturedSession: any;
    const app = buildApp(
      { oauthState: { value: 'state123', expiresAt: Date.now() + 60_000 } },
      (session) => { capturedSession = session; },
    );
    const res = await supertest(app).get('/discord/callback?code=code&state=state123');

    expect(res.status).toBe(302);
    expect(capturedSession.user).toMatchObject({
      discordId: '111',
      currentGuildId: '555',
      accessLevel: AccessLevel.MOD,
    });
  });

  it('updates discord name when fetchMemberDisplayName returns a value', async () => {
    mockFetch([
      { ok: true, json: () => Promise.resolve({ access_token: 'tok' }) },
      { ok: true, json: () => Promise.resolve({ id: '111', username: 'alice', avatar: null }) },
    ]);
    vi.mocked(findUser).mockResolvedValue({ discord_id: '111', discord_name: 'OldName', is_twitch_bot_enabled: false, twitch_name: null, access_level: AccessLevel.USER, is_owner: false } as any);
    vi.mocked(getGuildsForMember).mockResolvedValue([{ guild_id: '555', name: 'Guild', voice_channel_id: null }] as any);
    vi.mocked(fetchMemberDisplayName).mockResolvedValue('NewDisplayName');
    const res = await supertest(buildApp({ oauthState: { value: 'state123', expiresAt: Date.now() + 60_000 } }))
      .get('/discord/callback?code=code&state=state123');
    expect(res.status).toBe(302);
    expect(updateDiscordName).toHaveBeenCalledWith('111', 'NewDisplayName');
  });
});

// ─── GET /login ───────────────────────────────────────────────────────────────

describe('GET /login', () => {
  it('renders login page when not authenticated', async () => {
    const res = await supertest(buildApp()).get('/login');
    expect(res.status).toBe(200);
    expect((res.body as any).view).toBe('login');
  });

  it('redirects to / when already authenticated', async () => {
    const res = await supertest(buildApp({ user: { discordId: '1', discordName: 'Alice', accessLevel: AccessLevel.USER } })).get('/login');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});

// ─── POST /logout ─────────────────────────────────────────────────────────────

describe('POST /logout', () => {
  it('destroys session and redirects to /auth/login', async () => {
    const destroy = vi.fn((cb: () => void) => cb());
    const res = await supertest(buildApp({ user: { discordId: '1' }, destroy })).post('/logout');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
    expect(destroy).toHaveBeenCalled();
  });
});
