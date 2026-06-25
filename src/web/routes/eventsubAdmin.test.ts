import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../db', () => ({
  clearStreamerToken: vi.fn(),
}));

vi.mock('../../twitch/eventsub/twitchEventSub', () => ({
  reloadEventSubSubscriptions: vi.fn(),
}));

vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  },
}));

vi.mock('../middleware', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    if (req.session.user?.accessLevel >= 3) return next();
    res.status(403).render('error', { message: 'denied' });
  },
}));

import express from 'express';
import supertest from 'supertest';
import router from './eventsubAdmin';
import { clearStreamerToken } from '../../db';
import { reloadEventSubSubscriptions } from '../../twitch/eventsub/twitchEventSub';

/**
 * Builds a minimal Express app with the eventsub admin router mounted, a stubbed session, and res.render captured as JSON.
 * @param accessLevel - The access level to assign to the session user (defaults to Admin).
 * @returns The configured Express app, ready to be driven with supertest.
 */
function buildApp(accessLevel = 3) {
  const app = express();
  app.use((req: any, res: any, next: any) => {
    req.session = { user: { discordId: '1', accessLevel } };
    res.render = (view: string, locals?: any) => res.json({ view, ...locals });
    next();
  });
  app.use(router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(clearStreamerToken).mockResolvedValue(undefined);
});

describe('POST /streams/twitch-disconnect/:streamerId', () => {
  it('redirects with invalid_id when streamerId is not a positive integer', async () => {
    const res = await supertest(buildApp()).post('/streams/twitch-disconnect/not-a-number');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/streams?error=invalid_id');
    expect(clearStreamerToken).not.toHaveBeenCalled();
  });

  it('redirects with invalid_id for a zero id', async () => {
    const res = await supertest(buildApp()).post('/streams/twitch-disconnect/0');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/streams?error=invalid_id');
  });

  it('redirects with invalid_id for a negative id', async () => {
    const res = await supertest(buildApp()).post('/streams/twitch-disconnect/-1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/streams?error=invalid_id');
  });

  it('clears the token and triggers a reload on success', async () => {
    const res = await supertest(buildApp()).post('/streams/twitch-disconnect/42');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/streams');
    expect(clearStreamerToken).toHaveBeenCalledWith(42);
    expect(reloadEventSubSubscriptions).toHaveBeenCalledTimes(1);
  });

  it('redirects with eventsub_disconnect_failed when clearStreamerToken throws', async () => {
    vi.mocked(clearStreamerToken).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildApp()).post('/streams/twitch-disconnect/42');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/streams?error=eventsub_disconnect_failed');
    expect(reloadEventSubSubscriptions).not.toHaveBeenCalled();
  });

  it('denies access below Admin level', async () => {
    const res = await supertest(buildApp(2)).post('/streams/twitch-disconnect/42');
    expect(res.status).toBe(403);
    expect(clearStreamerToken).not.toHaveBeenCalled();
  });
});
