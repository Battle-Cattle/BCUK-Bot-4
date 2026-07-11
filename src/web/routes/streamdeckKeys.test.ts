import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  hasApiKey: vi.fn().mockResolvedValue(false),
  createApiKeyAndRequestGuildAccess: vi.fn().mockResolvedValue({ plain: 'a'.repeat(64), status: 'pending' }),
  requestGuildAccessForExistingKey: vi.fn().mockResolvedValue({ status: 'pending' }),
  rotateApiKey: vi.fn().mockResolvedValue({ plain: 'b'.repeat(64) }),
  getGuildStatusForKey: vi.fn().mockResolvedValue(null),
  revokeApiKey: vi.fn().mockResolvedValue(undefined),
  approveApiKey: vi.fn().mockResolvedValue(undefined),
  denyApiKey: vi.fn().mockResolvedValue(undefined),
  getAllApiKeys: vi.fn().mockResolvedValue([]),
  getPendingRequests: vi.fn().mockResolvedValue([]),
}));
vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-token';
    next();
  },
}));
vi.mock('../middleware', () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../shared/config', () => ({ WEB_PORT: 3000 }));
vi.mock('../../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) }));

import express from 'express';
import supertest from 'supertest';
import router, { __resetRecentRotationsForTests } from './streamdeckKeys';
import {
  hasApiKey, createApiKeyAndRequestGuildAccess, requestGuildAccessForExistingKey, rotateApiKey,
  getGuildStatusForKey, revokeApiKey,
  approveApiKey, denyApiKey, getAllApiKeys, getPendingRequests,
} from '../../db';
import { AccessLevel } from '../../db/users';

const GUILD_ID = '900000000000000001';
const SESSION_USER = {
  discordId: '111222333444555666',
  discordName: 'Alice',
  accessLevel: AccessLevel.ADMIN,
  currentGuildId: GUILD_ID,
  isOwner: false,
  guilds: [{ guildId: GUILD_ID, name: 'Test Guild' }],
};
const VALID_DISCORD_ID = '123456789012345678';

function buildApp(sessionUser = SESSION_USER) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req: any, _res: any, next: any) => {
    req.session = { user: sessionUser };
    next();
  });
  app.use((req: any, res: any, next: any) => {
    res.render = (view: string, locals: unknown) => res.json({ view, locals });
    next();
  });
  app.use(router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasApiKey).mockResolvedValue(false);
  vi.mocked(createApiKeyAndRequestGuildAccess).mockResolvedValue({ plain: 'a'.repeat(64), status: 'pending' } as any);
  vi.mocked(requestGuildAccessForExistingKey).mockResolvedValue({ status: 'pending' } as any);
  vi.mocked(rotateApiKey).mockResolvedValue({ plain: 'b'.repeat(64) } as any);
  vi.mocked(getGuildStatusForKey).mockResolvedValue(null);
  vi.mocked(getAllApiKeys).mockResolvedValue([]);
  vi.mocked(getPendingRequests).mockResolvedValue([]);
  __resetRecentRotationsForTests();
});

// ─── GET /streamdeck-key ──────────────────────────────────────────────────────

describe('GET /streamdeck-key', () => {
  it('renders streamdeck-keys with keyRow and webPort', async () => {
    const keyRow = { discord_id: '1', guild_id: GUILD_ID, status: 'pending', requested_at: new Date(), approved_at: null, approved_by: null };
    vi.mocked(getGuildStatusForKey).mockResolvedValue(keyRow as any);
    const res = await supertest(buildApp()).get('/streamdeck-key');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.view).toBe('streamdeck-keys');
    expect(body.locals.keyRow).toMatchObject({ discord_id: '1', status: 'pending' });
    expect(body.locals.webPort).toBe(3000);
    expect(body.locals.newKey).toBeNull();
    expect(getGuildStatusForKey).toHaveBeenCalledWith(SESSION_USER.discordId, GUILD_ID);
  });

  it('returns 500 on DB error', async () => {
    vi.mocked(getGuildStatusForKey).mockRejectedValueOnce(new Error('DB down'));
    const app = express();
    app.use((req: any, _res: any, next: any) => { req.session = { user: SESSION_USER }; next(); });
    app.use((req: any, res: any, next: any) => {
      (req as any).csrfToken = () => 'tok';
      res.render = (view: string, locals: unknown) => res.status((res as any).statusCode).json({ view, locals });
      next();
    });
    app.use(router);
    const res = await supertest(app).get('/streamdeck-key');
    expect(res.status).toBe(500);
  });
});

// ─── POST /streamdeck-key/request ────────────────────────────────────────────

describe('POST /streamdeck-key/request', () => {
  it('mints a brand-new key when the user has no existing guild status and no key', async () => {
    vi.mocked(getGuildStatusForKey)
      .mockResolvedValueOnce(null) // pre-check
      .mockResolvedValueOnce({ discord_id: '1', guild_id: GUILD_ID, status: 'pending' } as any); // post-request
    vi.mocked(hasApiKey).mockResolvedValue(false);

    const res = await supertest(buildApp()).post('/streamdeck-key/request');

    expect(res.status).toBe(200);
    expect((res.body as any).locals.newKey).toBeTruthy();
    expect(createApiKeyAndRequestGuildAccess).toHaveBeenCalledWith(SESSION_USER.discordId, SESSION_USER.accessLevel, GUILD_ID);
    expect(requestGuildAccessForExistingKey).not.toHaveBeenCalled();
    expect(rotateApiKey).not.toHaveBeenCalled();
  });

  it('reuses the existing key with no new plaintext when the user already has a key from another guild', async () => {
    vi.mocked(getGuildStatusForKey)
      .mockResolvedValueOnce(null) // no status for this guild yet
      .mockResolvedValueOnce({ discord_id: '1', guild_id: GUILD_ID, status: 'pending' } as any);
    vi.mocked(hasApiKey).mockResolvedValue(true);

    const res = await supertest(buildApp()).post('/streamdeck-key/request');

    expect(res.status).toBe(200);
    expect((res.body as any).locals.newKey).toBeNull();
    expect(requestGuildAccessForExistingKey).toHaveBeenCalledWith(SESSION_USER.discordId, SESSION_USER.accessLevel, GUILD_ID);
    expect(createApiKeyAndRequestGuildAccess).not.toHaveBeenCalled();
  });

  it('is idempotent — a duplicate request while approved neither creates nor rotates a key, and does not re-query the guild status', async () => {
    vi.mocked(getGuildStatusForKey).mockResolvedValue({ discord_id: '1', guild_id: GUILD_ID, status: 'approved' } as any);

    const res = await supertest(buildApp()).post('/streamdeck-key/request');

    expect(res.status).toBe(200);
    expect((res.body as any).locals.newKey).toBeNull();
    expect((res.body as any).locals.keyRow).toMatchObject({ status: 'approved' });
    expect(rotateApiKey).not.toHaveBeenCalled();
    expect(createApiKeyAndRequestGuildAccess).not.toHaveBeenCalled();
    expect(requestGuildAccessForExistingKey).not.toHaveBeenCalled();
    // The no-op branch reuses the status already fetched instead of a redundant re-query.
    expect(getGuildStatusForKey).toHaveBeenCalledOnce();
  });

  it('is idempotent — a duplicate request while pending neither creates nor rotates a key', async () => {
    vi.mocked(getGuildStatusForKey).mockResolvedValue({ discord_id: '1', guild_id: GUILD_ID, status: 'pending' } as any);

    const res = await supertest(buildApp()).post('/streamdeck-key/request');

    expect(res.status).toBe(200);
    expect((res.body as any).locals.newKey).toBeNull();
    expect((res.body as any).locals.keyRow).toMatchObject({ status: 'pending' });
    expect(rotateApiKey).not.toHaveBeenCalled();
    expect(createApiKeyAndRequestGuildAccess).not.toHaveBeenCalled();
    expect(requestGuildAccessForExistingKey).not.toHaveBeenCalled();
  });

  it('re-requests guild access instead of just rotating when this guild was previously revoked', async () => {
    vi.mocked(getGuildStatusForKey)
      .mockResolvedValueOnce({ discord_id: '1', guild_id: GUILD_ID, status: 'revoked' } as any)
      .mockResolvedValueOnce({ discord_id: '1', guild_id: GUILD_ID, status: 'pending' } as any);

    const res = await supertest(buildApp()).post('/streamdeck-key/request');

    expect(res.status).toBe(200);
    expect((res.body as any).locals.newKey).toBeNull();
    expect(requestGuildAccessForExistingKey).toHaveBeenCalledWith(SESSION_USER.discordId, SESSION_USER.accessLevel, GUILD_ID);
    expect(rotateApiKey).not.toHaveBeenCalled();
    expect(createApiKeyAndRequestGuildAccess).not.toHaveBeenCalled();
  });

  it('redirects to ?error=request_failed when this guild was previously denied', async () => {
    vi.mocked(getGuildStatusForKey).mockResolvedValue({ discord_id: '1', guild_id: GUILD_ID, status: 'denied' } as any);

    const res = await supertest(buildApp()).post('/streamdeck-key/request');

    expect(res.headers.location).toBe('/streamdeck-key?error=request_failed');
    expect(rotateApiKey).not.toHaveBeenCalled();
  });

  it('redirects to ?error=request_failed on error', async () => {
    vi.mocked(createApiKeyAndRequestGuildAccess).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/streamdeck-key/request');
    expect(res.headers.location).toBe('/streamdeck-key?error=request_failed');
  });

  it('serializes two concurrent requests from the same brand-new user, avoiding a duplicate-key race', async () => {
    const callOrder: string[] = [];
    let resolveFirstHasApiKey!: () => void;
    const firstHasApiKeyGate = new Promise<void>((resolve) => { resolveFirstHasApiKey = resolve; });
    let hasApiKeyCalls = 0;
    // Models the DB state createApiKeyAndRequestGuildAccess would actually
    // persist — without this, both requests would see "no existing key" and
    // the test would just be asserting the duplicate-insert race it claims to prevent.
    let persistedGuildStatus: { status: string } | null = null;

    vi.mocked(getGuildStatusForKey).mockImplementation(async () => persistedGuildStatus as any);
    vi.mocked(hasApiKey).mockImplementation(async () => {
      hasApiKeyCalls += 1;
      callOrder.push('hasApiKey-start');
      if (hasApiKeyCalls === 1) {
        await firstHasApiKeyGate;
      }
      callOrder.push('hasApiKey-end');
      return persistedGuildStatus !== null;
    });
    vi.mocked(createApiKeyAndRequestGuildAccess).mockImplementation(async () => {
      callOrder.push('create');
      persistedGuildStatus = { status: 'pending' };
      return { plain: 'a'.repeat(64), status: 'pending' };
    });
    const app = buildApp();
    // supertest/superagent requests are thenable but lazy — chaining .then()
    // immediately (rather than just holding the unawaited value) is what
    // actually dispatches the request.
    const firstReq = supertest(app).post('/streamdeck-key/request').then((r) => r);
    await vi.waitFor(() => expect(callOrder).toContain('hasApiKey-start'));
    const secondReq = supertest(app).post('/streamdeck-key/request').then((r) => r);

    // Give the second request every chance to (incorrectly) start its own
    // hasApiKey check before asserting it didn't — it should be stuck behind
    // the mutation queue holding the first request's in-flight operation.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callOrder).toEqual(['hasApiKey-start']);

    resolveFirstHasApiKey();
    await firstReq;
    await secondReq;

    // The second request only starts once the first has fully committed its
    // guild-status row, so it sees existingGuildStatus already set (pending)
    // and takes the idempotent no-op branch — it never even reaches the
    // hasApiKey check, let alone races into a second identity insert.
    expect(callOrder).toEqual(['hasApiKey-start', 'hasApiKey-end', 'create']);
    expect(createApiKeyAndRequestGuildAccess).toHaveBeenCalledTimes(1);
    expect(rotateApiKey).not.toHaveBeenCalled();
  });
});

// ─── POST /streamdeck-key/rotate ─────────────────────────────────────────────

describe('POST /streamdeck-key/rotate', () => {
  it('rotates the key when the user already has one, regardless of this guild\'s status', async () => {
    vi.mocked(hasApiKey).mockResolvedValue(true);
    vi.mocked(getGuildStatusForKey).mockResolvedValue({ discord_id: '1', guild_id: GUILD_ID, status: 'approved' } as any);

    const res = await supertest(buildApp()).post('/streamdeck-key/rotate');

    expect(res.status).toBe(200);
    expect((res.body as any).locals.newKey).toBeTruthy();
    expect((res.body as any).locals.keyRow).toMatchObject({ status: 'approved' });
    expect(rotateApiKey).toHaveBeenCalledWith(SESSION_USER.discordId);
  });

  it('redirects to ?error=rotate_failed when the user has no existing key', async () => {
    vi.mocked(hasApiKey).mockResolvedValue(false);

    const res = await supertest(buildApp()).post('/streamdeck-key/rotate');

    expect(res.headers.location).toBe('/streamdeck-key?error=rotate_failed');
    expect(rotateApiKey).not.toHaveBeenCalled();
  });

  it('redirects to ?error=rotate_failed on a DB error', async () => {
    vi.mocked(hasApiKey).mockResolvedValue(true);
    vi.mocked(rotateApiKey).mockRejectedValueOnce(new Error('DB error'));

    const res = await supertest(buildApp()).post('/streamdeck-key/rotate');

    expect(res.headers.location).toBe('/streamdeck-key?error=rotate_failed');
  });

  it('reads the guild status before rotating the key, not concurrently', async () => {
    vi.mocked(hasApiKey).mockResolvedValue(true);
    const callOrder: string[] = [];

    vi.mocked(getGuildStatusForKey).mockImplementation(async () => {
      callOrder.push('status');
      return { discord_id: '1', guild_id: GUILD_ID, status: 'approved' } as any;
    });
    vi.mocked(rotateApiKey).mockImplementation(async () => {
      callOrder.push('rotate');
      return { plain: 'b'.repeat(64) };
    });

    await supertest(buildApp()).post('/streamdeck-key/rotate');

    expect(callOrder).toEqual(['status', 'rotate']);
  });

  it('never rotates the key if reading the guild status fails first, so no plaintext is generated and lost', async () => {
    vi.mocked(hasApiKey).mockResolvedValue(true);
    vi.mocked(getGuildStatusForKey).mockRejectedValueOnce(new Error('DB down'));

    const res = await supertest(buildApp()).post('/streamdeck-key/rotate');

    expect(res.headers.location).toBe('/streamdeck-key?error=rotate_failed');
    expect(rotateApiKey).not.toHaveBeenCalled();
  });

  it('a rapid duplicate rotate within the dedupe window reuses the first rotation instead of rotating again', async () => {
    vi.mocked(hasApiKey).mockResolvedValue(true);
    vi.mocked(rotateApiKey).mockResolvedValue({ plain: 'first-plain-key' } as any);

    const app = buildApp();
    const first = await supertest(app).post('/streamdeck-key/rotate');
    expect((first.body as any).locals.newKey).toBe('first-plain-key');

    // If the dedupe guard failed to kick in, this second call would return
    // whatever rotateApiKey resolves to now — which is unchanged, so a
    // regression here wouldn't be masked by a queued "once" value.
    const second = await supertest(app).post('/streamdeck-key/rotate');

    expect((second.body as any).locals.newKey).toBe('first-plain-key');
    expect(rotateApiKey).toHaveBeenCalledOnce();
  });

  it('reuses the same rotated key across a guild switch within the dedupe window, but always reports the current guild\'s fresh status', async () => {
    const OTHER_GUILD_ID = '900000000000000002';
    const sessionInGuildA = SESSION_USER;
    const sessionInGuildB = { ...SESSION_USER, currentGuildId: OTHER_GUILD_ID };

    vi.mocked(hasApiKey).mockResolvedValue(true);
    vi.mocked(rotateApiKey).mockResolvedValue({ plain: 'shared-plain-key' } as any);
    vi.mocked(getGuildStatusForKey).mockImplementation(async (_discordId, guildId) => ({
      discord_id: SESSION_USER.discordId,
      guild_id: guildId,
      status: guildId === GUILD_ID ? 'approved' : 'pending',
    } as any));

    const appA = buildApp(sessionInGuildA);
    const firstInA = await supertest(appA).post('/streamdeck-key/rotate');
    expect((firstInA.body as any).locals.newKey).toBe('shared-plain-key');
    expect((firstInA.body as any).locals.keyRow).toMatchObject({ guild_id: GUILD_ID, status: 'approved' });

    // Same discordId, different guild, within the dedupe window — the
    // global key secret is reused (not rotated again, which would silently
    // invalidate the one just shown for guild A), but the guild's approval
    // status is still read fresh and correctly reflects guild B, not a
    // stale cached value from guild A.
    const appB = buildApp(sessionInGuildB);
    const firstInB = await supertest(appB).post('/streamdeck-key/rotate');
    expect((firstInB.body as any).locals.newKey).toBe('shared-plain-key');
    expect((firstInB.body as any).locals.keyRow).toMatchObject({ guild_id: OTHER_GUILD_ID, status: 'pending' });
    expect(rotateApiKey).toHaveBeenCalledOnce();
  });

  it('rotates again once the dedupe window has passed', async () => {
    // Uses a Date.now() spy (not fake timers) so supertest's real HTTP round
    // trip isn't disrupted — the dedupe check reads Date.now() lazily, so
    // there's no setTimeout/interval involved to fake.
    const dateNowSpy = vi.spyOn(Date, 'now');
    try {
      vi.mocked(hasApiKey).mockResolvedValue(true);
      vi.mocked(rotateApiKey).mockResolvedValueOnce({ plain: 'first-plain-key' } as any);
      dateNowSpy.mockReturnValue(1_000_000);

      const app = buildApp();
      const first = await supertest(app).post('/streamdeck-key/rotate');
      expect((first.body as any).locals.newKey).toBe('first-plain-key');

      vi.mocked(rotateApiKey).mockResolvedValueOnce({ plain: 'second-plain-key' } as any);
      dateNowSpy.mockReturnValue(1_000_000 + 10_000 + 1);

      const second = await supertest(app).post('/streamdeck-key/rotate');

      expect((second.body as any).locals.newKey).toBe('second-plain-key');
      expect(rotateApiKey).toHaveBeenCalledTimes(2);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('actively evicts the cached plaintext once the dedupe window elapses, not just on next access', async () => {
    // Captures the scheduled eviction callback instead of letting a real
    // timer fire, then invokes it directly — proving eviction happens via
    // that callback (not merely via the lazy age check on next read) by
    // triggering a second rotation while Date.now() is still unchanged
    // (i.e. still "within window" by age alone).
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      vi.mocked(hasApiKey).mockResolvedValue(true);
      vi.mocked(rotateApiKey).mockResolvedValueOnce({ plain: 'first-plain-key' } as any);

      const app = buildApp();
      await supertest(app).post('/streamdeck-key/rotate');

      const [callback, delay] = setTimeoutSpy.mock.calls.at(-1)!;
      expect(delay).toBe(10_000);
      (callback as () => void)();

      vi.mocked(rotateApiKey).mockResolvedValueOnce({ plain: 'second-plain-key' } as any);
      const second = await supertest(app).post('/streamdeck-key/rotate');

      expect((second.body as any).locals.newKey).toBe('second-plain-key');
      expect(rotateApiKey).toHaveBeenCalledTimes(2);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

// ─── POST /streamdeck-key/revoke ──────────────────────────────────────────────

describe('POST /streamdeck-key/revoke', () => {
  it('redirects to /streamdeck-key on success, scoped to the current guild', async () => {
    const res = await supertest(buildApp()).post('/streamdeck-key/revoke');
    expect(res.headers.location).toBe('/streamdeck-key');
    expect(revokeApiKey).toHaveBeenCalledWith(SESSION_USER.discordId, GUILD_ID);
  });

  it('redirects to ?error=revoke_failed on error', async () => {
    vi.mocked(revokeApiKey).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/streamdeck-key/revoke');
    expect(res.headers.location).toBe('/streamdeck-key?error=revoke_failed');
  });
});

// ─── GET /admin/streamdeck-keys ───────────────────────────────────────────────

describe('GET /admin/streamdeck-keys', () => {
  it('renders streamdeck-keys-admin with pending and all lists', async () => {
    vi.mocked(getPendingRequests).mockResolvedValue([{ discord_id: '1', status: 'pending' }] as any);
    vi.mocked(getAllApiKeys).mockResolvedValue([{ discord_id: '1', status: 'approved' }] as any);
    const res = await supertest(buildApp()).get('/admin/streamdeck-keys');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.view).toBe('streamdeck-keys-admin');
    expect(body.locals.pending).toHaveLength(1);
    expect(body.locals.all).toHaveLength(1);
  });

  it('returns 500 on DB error', async () => {
    vi.mocked(getPendingRequests).mockRejectedValueOnce(new Error('DB down'));
    const app = express();
    app.use((req: any, _res: any, next: any) => { req.session = { user: SESSION_USER }; next(); });
    app.use((req: any, res: any, next: any) => {
      (req as any).csrfToken = () => 'tok';
      res.render = (view: string, locals: unknown) => res.status((res as any).statusCode).json({ view, locals });
      next();
    });
    app.use(router);
    const res = await supertest(app).get('/admin/streamdeck-keys');
    expect(res.status).toBe(500);
  });
});

// ─── POST /admin/streamdeck-keys/approve ─────────────────────────────────────

describe('POST /admin/streamdeck-keys/approve', () => {
  it('approves key and redirects to /admin/streamdeck-keys', async () => {
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/approve').send(`discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/admin/streamdeck-keys');
    expect(approveApiKey).toHaveBeenCalledWith(VALID_DISCORD_ID, SESSION_USER.discordId, GUILD_ID);
  });

  it('redirects to ?error=invalid_discord_id for invalid ID', async () => {
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/approve').send('discord_id=bad');
    expect(res.headers.location).toBe('/admin/streamdeck-keys?error=invalid_discord_id');
  });

  it('redirects to ?error=approve_failed on DB error', async () => {
    vi.mocked(approveApiKey).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/approve').send(`discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/admin/streamdeck-keys?error=approve_failed');
  });
});

// ─── POST /admin/streamdeck-keys/deny ────────────────────────────────────────

describe('POST /admin/streamdeck-keys/deny', () => {
  it('denies key and redirects', async () => {
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/deny').send(`discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/admin/streamdeck-keys');
    expect(denyApiKey).toHaveBeenCalledWith(VALID_DISCORD_ID, GUILD_ID);
  });

  it('redirects to ?error=invalid_discord_id for invalid ID', async () => {
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/deny').send('discord_id=bad');
    expect(res.headers.location).toBe('/admin/streamdeck-keys?error=invalid_discord_id');
  });

  it('redirects to ?error=deny_failed on DB error', async () => {
    vi.mocked(denyApiKey).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/deny').send(`discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/admin/streamdeck-keys?error=deny_failed');
  });
});

// ─── POST /admin/streamdeck-keys/revoke ──────────────────────────────────────

describe('POST /admin/streamdeck-keys/revoke', () => {
  it('revokes key and redirects', async () => {
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/revoke').send(`discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/admin/streamdeck-keys');
    expect(revokeApiKey).toHaveBeenCalledWith(VALID_DISCORD_ID, GUILD_ID);
  });

  it('redirects to ?error=invalid_discord_id for invalid ID', async () => {
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/revoke').send('discord_id=bad');
    expect(res.headers.location).toBe('/admin/streamdeck-keys?error=invalid_discord_id');
  });

  it('redirects to ?error=revoke_failed on DB error', async () => {
    vi.mocked(revokeApiKey).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/revoke').send(`discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/admin/streamdeck-keys?error=revoke_failed');
  });
});
