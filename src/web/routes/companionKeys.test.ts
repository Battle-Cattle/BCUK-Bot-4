import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  issueToken: vi.fn(),
  getTokenStatus: vi.fn(),
  revokeToken: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-token';
    next();
  },
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({ WEB_PORT: 3000 }));
vi.mock('./companionEvents', () => ({ disconnectCompanionConnections: vi.fn() }));

import express from 'express';
import supertest from 'supertest';
import router, { __resetRecentIssuesForTests } from './companionKeys';
import { issueToken, getTokenStatus, revokeToken } from '../../db';
import { AccessLevel } from '../../db';
import { disconnectCompanionConnections } from './companionEvents';
import { buildTestApp } from '../../test-utils/expressTestApp';

const GUILD_ID = '900000000000000001';
const SESSION_USER = {
  discordId: '111222333444555666',
  discordName: 'Alice',
  accessLevel: AccessLevel.USER,
  currentGuildId: GUILD_ID,
  isOwner: false,
  guilds: [{ guildId: GUILD_ID, name: 'Test Guild' }],
};

/** Builds a supertest-ready app: the companion keys router with a stubbed session and a render mock that nests locals under a `locals` key. */
function buildApp(sessionUser = SESSION_USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser, mockRender: 'nested' });
}

/**
 * Finds a route's handler function directly from the router's internal stack, bypassing HTTP
 * entirely — needed to invoke the handler twice back-to-back with no real I/O in between, so a
 * second call deterministically lands while the first is still awaiting an unresolved promise.
 */
function getRouteHandler(routePath: string): (req: any, res: any, next: any) => Promise<void> | void {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** Builds a minimal req/res pair for calling a companionKeys handler directly (see `getRouteHandler`). */
function makeDirectCallReqRes() {
  const req = { session: { user: SESSION_USER }, csrfToken: () => 'test-token' } as any;
  const res: any = { render: vi.fn(), redirect: vi.fn() };
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRecentIssuesForTests();
  vi.mocked(getTokenStatus).mockResolvedValue(null);
  vi.mocked(issueToken).mockResolvedValue('a'.repeat(64));
  vi.mocked(revokeToken).mockResolvedValue(undefined);
});

// ─── GET /companion-key ────────────────────────────────────────────────────────

describe('GET /companion-key', () => {
  it('renders companion-keys with tokenStatus and webPort', async () => {
    const tokenStatus = { hasToken: true, createdAt: new Date() };
    vi.mocked(getTokenStatus).mockResolvedValue(tokenStatus as any);
    const res = await supertest(buildApp()).get('/companion-key');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.view).toBe('companion-keys');
    expect(body.locals.tokenStatus).toMatchObject({ hasToken: true });
    expect(body.locals.newToken).toBeNull();
    expect(getTokenStatus).toHaveBeenCalledWith(SESSION_USER.discordId);
  });

  it('returns 500 on DB error', async () => {
    vi.mocked(getTokenStatus).mockRejectedValueOnce(new Error('DB down'));
    const app = express();
    app.use((req: any, _res: any, next: any) => { req.session = { user: SESSION_USER }; next(); });
    app.use((req: any, res: any, next: any) => {
      (req as any).csrfToken = () => 'tok';
      res.render = (view: string, locals: unknown) => res.status((res as any).statusCode).json({ view, locals });
      next();
    });
    app.use(router);
    const res = await supertest(app).get('/companion-key');
    expect(res.status).toBe(500);
  });
});

// ─── POST /companion-key/request ──────────────────────────────────────────────

describe('POST /companion-key/request', () => {
  it('renders companion-keys with the plain token on success', async () => {
    vi.mocked(issueToken).mockResolvedValue('plain-token-value');
    vi.mocked(getTokenStatus).mockResolvedValue({ hasToken: true, createdAt: new Date() } as any);
    const res = await supertest(buildApp()).post('/companion-key/request');
    expect(res.status).toBe(200);
    expect((res.body as any).locals.newToken).toBe('plain-token-value');
    expect(issueToken).toHaveBeenCalledWith(SESSION_USER.discordId);
  });

  it('redirects to ?error=request_failed on error', async () => {
    vi.mocked(issueToken).mockRejectedValueOnce(new Error('denied'));
    const res = await supertest(buildApp()).post('/companion-key/request');
    expect(res.headers.location).toBe('/companion-key?error=request_failed');
  });

  it('ends any open companion SSE connections for the user after issuing a new token', async () => {
    vi.mocked(issueToken).mockResolvedValue('plain-token-value');
    vi.mocked(getTokenStatus).mockResolvedValue({ hasToken: true, createdAt: new Date() } as any);
    await supertest(buildApp()).post('/companion-key/request');
    // A new token invalidates any prior one, so a connection still open under the old token
    // must be disconnected — otherwise it would keep streaming under a now-replaced credential.
    expect(disconnectCompanionConnections).toHaveBeenCalledWith(SESSION_USER.discordId);
  });

  it('does not disconnect connections when issuing the token itself fails', async () => {
    vi.mocked(issueToken).mockRejectedValueOnce(new Error('denied'));
    await supertest(buildApp()).post('/companion-key/request');
    expect(disconnectCompanionConnections).not.toHaveBeenCalled();
  });

  it('a rapid duplicate request within the dedupe window reuses the first token instead of issuing again', async () => {
    vi.mocked(issueToken).mockResolvedValue('first-plain-token');

    const app = buildApp();
    const first = await supertest(app).post('/companion-key/request');
    expect((first.body as any).locals.newToken).toBe('first-plain-token');

    // If the dedupe guard failed to kick in, this second call would return whatever
    // issueToken resolves to now — which is unchanged, so a regression here wouldn't be
    // masked by a queued "once" value.
    const second = await supertest(app).post('/companion-key/request');

    expect((second.body as any).locals.newToken).toBe('first-plain-token');
    expect(issueToken).toHaveBeenCalledOnce();
    expect(disconnectCompanionConnections).toHaveBeenCalledOnce();
  });

  it('issues again once the dedupe window has passed', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now');
    try {
      vi.mocked(issueToken).mockResolvedValueOnce('first-plain-token');
      dateNowSpy.mockReturnValue(1_000_000);

      const app = buildApp();
      const first = await supertest(app).post('/companion-key/request');
      expect((first.body as any).locals.newToken).toBe('first-plain-token');

      vi.mocked(issueToken).mockResolvedValueOnce('second-plain-token');
      dateNowSpy.mockReturnValue(1_000_000 + 10_000 + 1);

      const second = await supertest(app).post('/companion-key/request');

      expect((second.body as any).locals.newToken).toBe('second-plain-token');
      expect(issueToken).toHaveBeenCalledTimes(2);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("evicts the dedupe entry via its own timer once the window elapses, so it doesn't linger in memory", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(issueToken).mockResolvedValueOnce('first-plain-token');
      const app = buildApp();
      await supertest(app).post('/companion-key/request');

      await vi.advanceTimersByTimeAsync(10_000);

      // The eviction timer having fired is only observable indirectly: with the entry gone,
      // a request right after (still logically "instant", but a fresh Date.now() tick under
      // fake timers) must issue again rather than reuse the stale plaintext.
      vi.mocked(issueToken).mockResolvedValueOnce('second-plain-token');
      const second = await supertest(app).post('/companion-key/request');

      expect((second.body as any).locals.newToken).toBe('second-plain-token');
      expect(issueToken).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stale eviction timer does not delete a newer entry issued for the same user in the meantime', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(issueToken).mockResolvedValueOnce('first-plain-token');
      const app = buildApp();
      await supertest(app).post('/companion-key/request');

      // Revoke replaces the first entry's timer with nothing, then a fresh request schedules a
      // brand-new timer for a second entry — the first entry's now-stale timer is still pending.
      await vi.advanceTimersByTimeAsync(5_000);
      await supertest(app).post('/companion-key/revoke');
      vi.mocked(issueToken).mockResolvedValueOnce('second-plain-token');
      await supertest(app).post('/companion-key/request');

      // Advance to when the first (stale) timer fires. The `recentIssues.get(...) === result`
      // guard must keep it from deleting the second entry.
      await vi.advanceTimersByTimeAsync(5_000);

      const third = await supertest(app).post('/companion-key/request');
      expect((third.body as any).locals.newToken).toBe('second-plain-token');
      expect(issueToken).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces two concurrent requests onto a single issueToken call, so both get the same token', async () => {
    let resolveIssue!: (value: string) => void;
    vi.mocked(issueToken).mockReturnValueOnce(new Promise((resolve) => { resolveIssue = resolve; }));
    vi.mocked(getTokenStatus).mockResolvedValue({ hasToken: true, createdAt: new Date() } as any);

    const handler = getRouteHandler('/companion-key/request');
    const first = makeDirectCallReqRes();
    const second = makeDirectCallReqRes();

    // Both calls start before issueToken resolves: the first synchronously registers itself in
    // the per-discordId mutation queue before this line returns, so the second call — started
    // immediately after — is queued behind it and, once its turn comes, finds the first call's
    // now-cached token instead of calling issueToken again.
    const firstCall = handler(first.req, first.res, vi.fn());
    const secondCall = handler(second.req, second.res, vi.fn());
    resolveIssue('shared-plain-token');
    await Promise.all([firstCall, secondCall]);

    expect(first.res.render).toHaveBeenCalledWith('companion-keys', expect.objectContaining({ newToken: 'shared-plain-token' }));
    expect(second.res.render).toHaveBeenCalledWith('companion-keys', expect.objectContaining({ newToken: 'shared-plain-token' }));
    expect(issueToken).toHaveBeenCalledOnce();
    expect(disconnectCompanionConnections).toHaveBeenCalledOnce();
  });
});

// ─── POST /companion-key/revoke ───────────────────────────────────────────────

describe('POST /companion-key/revoke', () => {
  it('redirects to /companion-key on success', async () => {
    const res = await supertest(buildApp()).post('/companion-key/revoke');
    expect(res.headers.location).toBe('/companion-key');
    expect(revokeToken).toHaveBeenCalledWith(SESSION_USER.discordId);
  });

  it('ends any open companion SSE connections for the user after a successful revoke', async () => {
    await supertest(buildApp()).post('/companion-key/revoke');
    expect(disconnectCompanionConnections).toHaveBeenCalledWith(SESSION_USER.discordId);
  });

  it('redirects to ?error=revoke_failed on error', async () => {
    vi.mocked(revokeToken).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/companion-key/revoke');
    expect(res.headers.location).toBe('/companion-key?error=revoke_failed');
  });

  it('does not disconnect connections when the revoke itself fails', async () => {
    vi.mocked(revokeToken).mockRejectedValueOnce(new Error('DB error'));
    await supertest(buildApp()).post('/companion-key/revoke');
    expect(disconnectCompanionConnections).not.toHaveBeenCalled();
  });

  it('clears the issue dedupe cache, so a request right after a revoke issues a fresh token', async () => {
    vi.mocked(issueToken).mockResolvedValueOnce('first-plain-token');
    const app = buildApp();
    await supertest(app).post('/companion-key/request');

    await supertest(app).post('/companion-key/revoke');

    vi.mocked(issueToken).mockResolvedValueOnce('second-plain-token');
    const res = await supertest(app).post('/companion-key/request');

    expect((res.body as any).locals.newToken).toBe('second-plain-token');
    expect(issueToken).toHaveBeenCalledTimes(2);
  });

  it('a revoke that arrives while an issuance is in flight runs after it settles, so it is not undone by that issuance', async () => {
    let resolveIssue!: (value: string) => void;
    vi.mocked(issueToken).mockReturnValueOnce(new Promise((resolve) => { resolveIssue = resolve; }));

    const requestHandler = getRouteHandler('/companion-key/request');
    const revokeHandler = getRouteHandler('/companion-key/revoke');

    // The issuance starts first and is still in flight (its issueToken call unresolved) when the
    // revoke arrives — both share the same per-discordId mutation queue, so the revoke queues
    // behind the issuance rather than racing its DB write.
    const first = makeDirectCallReqRes();
    const firstCall = requestHandler(first.req, first.res, vi.fn());
    const revokeReqRes = makeDirectCallReqRes();
    const revokeCall = revokeHandler(revokeReqRes.req, revokeReqRes.res, vi.fn());

    resolveIssue('in-flight-token');
    await firstCall;
    await revokeCall;

    expect(revokeToken).toHaveBeenCalledWith(SESSION_USER.discordId);
    expect(revokeReqRes.res.redirect).toHaveBeenCalledWith('/companion-key');

    // Because the revoke ran after the issuance's cache write (not clobbered by it), the next
    // request must issue a fresh token rather than reuse the now-revoked cached one.
    vi.mocked(issueToken).mockResolvedValueOnce('fresh-after-revoke-token');
    const after = makeDirectCallReqRes();
    await requestHandler(after.req, after.res, vi.fn());

    expect(after.res.render).toHaveBeenCalledWith('companion-keys', expect.objectContaining({ newToken: 'fresh-after-revoke-token' }));
    expect(issueToken).toHaveBeenCalledTimes(2);
  });
});
