import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../shared/healthStore', () => ({
  getHealthSnapshot: vi.fn(),
}));

vi.mock('../../shared/debugLogging', () => ({
  enableDebugLogging: vi.fn(),
  disableDebugLogging: vi.fn(),
  getDebugLoggingUntil: vi.fn(() => null),
  DEFAULT_DEBUG_LOGGING_HOURS: 24,
  MAX_DEBUG_LOGGING_HOURS: 72,
}));

// viewHelpers.ts (used by health.ts for renderView/renderError) imports `getStreamerByDiscordId`
// from '../../db' at module load — mocked here purely so that transitive import doesn't pull in
// the real db/pool module, which requires DB_* env vars to be set.
vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
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
import router from './health';
import { getHealthSnapshot } from '../../shared/healthStore';
import { enableDebugLogging, disableDebugLogging, getDebugLoggingUntil } from '../../shared/debugLogging';
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

const SNAPSHOT = {
  discordConnected: true,
  twitchChatConnected: true,
  db: { lastPingOk: true, lastPingAt: null, lastError: null },
  eventsub: {},
  monitor: { lastPollOk: true, lastPollAt: null, lastError: null },
  schedulers: {},
  errors: [],
};

function buildApp(sessionUser: unknown) {
  return buildTestApp({ router, sessionUser, mockRender: 'nested', bodyParser: 'urlencoded' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getHealthSnapshot).mockReturnValue(SNAPSHOT as any);
  vi.mocked(getDebugLoggingUntil).mockReturnValue(null);
  vi.mocked(enableDebugLogging).mockResolvedValue(new Date());
  vi.mocked(disableDebugLogging).mockResolvedValue();
});

describe('GET /admin/health', () => {
  it('renders the health view with a snapshot for the owner', async () => {
    const res = await supertest(buildApp(OWNER_SESSION_USER)).get('/');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.view).toBe('health');
    expect(body.locals.health).toEqual(SNAPSHOT);
  });

  it('passes the debug logging state, the duration choices and a known status code to the view', async () => {
    const until = new Date('2026-10-27T12:00:00Z');
    vi.mocked(getDebugLoggingUntil).mockReturnValue(until);

    const res = await supertest(buildApp(OWNER_SESSION_USER)).get('/?success=debug_on&error=bogus');

    const { locals } = res.body as any;
    expect(locals.debugLoggingUntil).toBe(until.toISOString());
    expect(locals.debugLoggingHourOptions).toEqual([1, 6, 24, 72]);
    expect(locals.defaultDebugLoggingHours).toBe(24);
    expect(locals.success).toBe('debug_on');
    expect(locals.error).toBeUndefined();
  });

  it('sets Cache-Control: no-store so browsers/proxies never cache the owner health data', async () => {
    const res = await supertest(buildApp(OWNER_SESSION_USER)).get('/');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('renders a 500 error page if building the health snapshot response throws', async () => {
    vi.mocked(getHealthSnapshot).mockImplementation(() => {
      throw new Error('snapshot boom');
    });

    const res = await supertest(buildApp(OWNER_SESSION_USER)).get('/');

    expect(res.status).toBe(500);
    const body = res.body as any;
    expect(body.view).toBe('error');
    expect(body.locals.message).toBe('Failed to load health dashboard.');
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

describe('POST /admin/health/debug-logging', () => {
  it('turns debug logging on for the chosen hours and redirects with a success code', async () => {
    const res = await supertest(buildApp(OWNER_SESSION_USER))
      .post('/debug-logging').type('form').send({ action: 'enable', hours: '6' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/health?success=debug_on');
    expect(vi.mocked(enableDebugLogging)).toHaveBeenCalledExactlyOnceWith(6);
  });

  it('turns debug logging off and redirects with a success code', async () => {
    const res = await supertest(buildApp(OWNER_SESSION_USER))
      .post('/debug-logging').type('form').send({ action: 'disable' });

    expect(res.headers.location).toBe('/admin/health?success=debug_off');
    expect(vi.mocked(disableDebugLogging)).toHaveBeenCalledOnce();
  });

  it.each([
    ['an unlisted duration', { action: 'enable', hours: '5' }],
    ['a missing duration', { action: 'enable' }],
    ['an unknown action', { action: 'explode', hours: '24' }],
  ])('rejects %s', async (_case, form) => {
    const res = await supertest(buildApp(OWNER_SESSION_USER)).post('/debug-logging').type('form').send(form);

    expect(res.headers.location).toBe('/admin/health?error=debug_invalid');
    expect(vi.mocked(enableDebugLogging)).not.toHaveBeenCalled();
  });

  it('redirects with an error code when the change fails', async () => {
    vi.mocked(enableDebugLogging).mockRejectedValue(new Error('disk full'));

    const res = await supertest(buildApp(OWNER_SESSION_USER))
      .post('/debug-logging').type('form').send({ action: 'enable', hours: '24' });

    expect(res.headers.location).toBe('/admin/health?error=debug_failed');
  });

  it('blocks a non-owner with a 403', async () => {
    const res = await supertest(buildApp(NON_OWNER_SESSION_USER))
      .post('/debug-logging').type('form').send({ action: 'enable', hours: '24' });

    expect(res.status).toBe(403);
    expect(vi.mocked(enableDebugLogging)).not.toHaveBeenCalled();
  });
});
