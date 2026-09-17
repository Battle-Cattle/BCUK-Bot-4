import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../db', () => ({
  getBotChatToken: vi.fn(),
}));

vi.mock('../../twitch/eventsub/twitchApiEventSub', () => ({
  getUserFromToken: vi.fn(),
}));

vi.mock('../../shared/config', () => ({
  TWITCH_CLIENT_ID: 'test-client-id',
  TWITCH_BOT_OAUTH_REDIRECT_URI: 'https://example.com/auth/twitch/bot/callback',
  EVENTSUB_TOKEN_SECRET: 'a'.repeat(64),
}));

vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-token';
    next();
  },
}));

vi.mock('../middleware', () => ({
  requireOwner: (req: any, res: any, next: any) => {
    if (req.session?.user?.isOwner) return next();
    res.status(403).json({ error: 'forbidden' });
  },
}));

import supertest from 'supertest';
import router from './botAuth';
import { getBotChatToken } from '../../db';
import { getUserFromToken } from '../../twitch/eventsub/twitchApiEventSub';
import { buildTestApp } from '../../test-utils/expressTestApp';

const OWNER_SESSION_USER = {
  discordId: '1',
  discordName: 'Owner',
  accessLevel: 3,
  currentGuildId: null,
  isOwner: true,
  guilds: [],
};

const NON_OWNER_SESSION_USER = { ...OWNER_SESSION_USER, isOwner: false };

const STORED_TOKEN = {
  twitchUserId: 'bot-uid',
  accessToken: 'access',
  refreshToken: 'refresh',
  tokenExpiry: null,
};

function buildApp(sessionUser: unknown) {
  return buildTestApp({ router, sessionUser, mockRender: 'nested' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBotChatToken).mockResolvedValue(null);
  vi.mocked(getUserFromToken).mockResolvedValue({ id: 'bot-uid', login: 'thebot' } as any);
});

describe('GET /admin/bot-auth', () => {
  it('renders not-connected when no token is stored', async () => {
    const res = await supertest(buildApp(OWNER_SESSION_USER)).get('/');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.view).toBe('botAuth');
    expect(body.locals.isConnected).toBe(false);
    expect(body.locals.connectedLogin).toBeNull();
  });

  it('renders connected with the live-validated login when a token is stored', async () => {
    vi.mocked(getBotChatToken).mockResolvedValue(STORED_TOKEN as any);
    const res = await supertest(buildApp(OWNER_SESSION_USER)).get('/');
    const body = res.body as any;
    expect(body.locals.isConnected).toBe(true);
    expect(body.locals.connectedLogin).toBe('thebot');
    expect(vi.mocked(getUserFromToken)).toHaveBeenCalledWith('access');
  });

  it('renders connected with a null login when the stored token no longer validates', async () => {
    vi.mocked(getBotChatToken).mockResolvedValue(STORED_TOKEN as any);
    vi.mocked(getUserFromToken).mockResolvedValue(null);
    const res = await supertest(buildApp(OWNER_SESSION_USER)).get('/');
    const body = res.body as any;
    expect(body.locals.isConnected).toBe(true);
    expect(body.locals.connectedLogin).toBeNull();
  });

  it('renders a 500 error page if loading the token throws', async () => {
    vi.mocked(getBotChatToken).mockRejectedValue(new Error('db boom'));
    const res = await supertest(buildApp(OWNER_SESSION_USER)).get('/');
    expect(res.status).toBe(500);
    const body = res.body as any;
    expect(body.view).toBe('error');
  });

  it('blocks a non-owner with a 403', async () => {
    const res = await supertest(buildApp(NON_OWNER_SESSION_USER)).get('/');
    expect(res.status).toBe(403);
  });

  it('blocks an unauthenticated request with a 403', async () => {
    const res = await supertest(buildApp(undefined)).get('/');
    expect(res.status).toBe(403);
  });
});

describe('GET /admin/bot-auth/connect', () => {
  it('redirects to Twitch authorize with chat:read chat:edit scope', async () => {
    const res = await supertest(buildApp(OWNER_SESSION_USER)).get('/connect');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(location.searchParams.get('scope')).toBe('chat:read chat:edit');
    expect(location.searchParams.get('client_id')).toBe('test-client-id');
    expect(location.searchParams.get('redirect_uri')).toBe('https://example.com/auth/twitch/bot/callback');
    expect(location.searchParams.get('state')).toBeTruthy();
  });

  it('blocks a non-owner with a 403', async () => {
    const res = await supertest(buildApp(NON_OWNER_SESSION_USER)).get('/connect');
    expect(res.status).toBe(403);
  });
});
