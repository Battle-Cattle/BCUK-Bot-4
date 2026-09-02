import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../test-utils/accessLevelMock';

vi.mock('../db', () => ({
  findKeyByHash: vi.fn(),
  findDiscordIdByTokenHash: vi.fn(),
  getEffectiveAccessLevelForUser: vi.fn(),
  findUser: vi.fn(),
  getAllGuilds: vi.fn(),
  getGuildsForMember: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
vi.mock('./csrf', () => ({
  ensureSessionCsrfToken: vi.fn().mockReturnValue('csrf-token'),
}));

import { createHash } from 'crypto';
import { requireAuth, requireManager, requireMod, requireAdmin, requireOwner, requireOwnerJson, requireModJson, requireManagerJson, requireAdminJson, requireApiKey, requireCompanionKey, requireGuildContext } from './middleware';
import { findKeyByHash, findDiscordIdByTokenHash, getEffectiveAccessLevelForUser, findUser, getAllGuilds, getGuildsForMember, AccessLevel } from '../db';

function makeReq(overrides: object = {}): any {
  return {
    session: {},
    headers: {},
    ...overrides,
  };
}

function makeRes(): any {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    redirect: vi.fn(),
    render: vi.fn(),
    json: vi.fn(),
  };
  return res;
}

const next = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── requireAuth ─────────────────────────────────────────────────────────────

describe('requireAuth', () => {
  it('calls next() when session.user is set', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.USER } } });
    requireAuth(req, makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('redirects to /auth/login when session.user is absent', () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    requireAuth(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith('/auth/login');
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── requireMod ──────────────────────────────────────────────────────────────

describe('requireMod', () => {
  it('calls next() when access level is MOD (1)', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.MOD } } });
    requireMod(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next() when access level is higher than MOD', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.ADMIN } } });
    requireMod(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when access level is USER (0)', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.USER } } });
    const res = makeRes();
    requireMod(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.render).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when session.user is absent', () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    requireMod(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('renders error template with Mod-required message', () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    requireMod(req, res, next);
    const [template, data] = res.render.mock.calls[0];
    expect(template).toBe('error');
    expect(data.message).toContain('Mod');
  });
});

// ─── requireManager ──────────────────────────────────────────────────────────

describe('requireManager', () => {
  it('calls next() when access level is MANAGER (2)', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.MANAGER } } });
    requireManager(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next() when access level is ADMIN (3)', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.ADMIN } } });
    requireManager(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when access level is MOD (1)', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.MOD } } });
    const res = makeRes();
    requireManager(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when no session user', () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    requireManager(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('renders error template with Manager-required message', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.USER } } });
    const res = makeRes();
    requireManager(req, res, next);
    const [template, data] = res.render.mock.calls[0];
    expect(template).toBe('error');
    expect(data.message).toContain('Manager');
  });
});

// ─── requireAdmin ─────────────────────────────────────────────────────────────

describe('requireAdmin', () => {
  it('calls next() when access level is ADMIN (3)', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.ADMIN } } });
    requireAdmin(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when access level is MANAGER (2)', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.MANAGER } } });
    const res = makeRes();
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when no session user', () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('renders error template with Admin-required message', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.USER } } });
    const res = makeRes();
    requireAdmin(req, res, next);
    const [, data] = res.render.mock.calls[0];
    expect(data.message).toContain('Admin');
  });
});

// ─── requireOwner ─────────────────────────────────────────────────────────────

describe('requireOwner', () => {
  it('calls next() when isOwner is true, regardless of accessLevel', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.USER, isOwner: true } } });
    requireOwner(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 403 for an Admin who is not the owner', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.ADMIN, isOwner: false } } });
    const res = makeRes();
    requireOwner(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when isOwner is absent', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.ADMIN } } });
    const res = makeRes();
    requireOwner(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 403 when no session user', () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    requireOwner(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('renders error template with an Owner-required message', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.ADMIN, isOwner: false } } });
    const res = makeRes();
    requireOwner(req, res, next);
    const [, data] = res.render.mock.calls[0];
    expect(data.message).toContain('Owner');
  });
});

// ─── requireOwnerJson ─────────────────────────────────────────────────────────

describe('requireOwnerJson', () => {
  it('calls next() when isOwner is true, regardless of accessLevel', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.USER, isOwner: true } } });
    requireOwnerJson(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('returns a JSON 403 for an Admin who is not the owner', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.ADMIN, isOwner: false } } });
    const res = makeRes();
    requireOwnerJson(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'forbidden' });
    expect(res.render).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns a JSON 403 when isOwner is absent', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.ADMIN } } });
    const res = makeRes();
    requireOwnerJson(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'forbidden' });
  });

  it('returns a JSON 403 when no session user', () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    requireOwnerJson(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'forbidden' });
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── requireModJson ────────────────────────────────────────────────────────────

describe('requireModJson', () => {
  it('calls next() when access level is MOD (1)', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.MOD } } });
    requireModJson(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('returns a JSON 403 when access level is USER (0)', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.USER } } });
    const res = makeRes();
    requireModJson(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'forbidden' });
    expect(res.render).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns a JSON 403 when session.user is absent', () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    requireModJson(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'forbidden' });
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── requireManagerJson ────────────────────────────────────────────────────────

describe('requireManagerJson', () => {
  it('calls next() when access level is MANAGER (2)', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.MANAGER } } });
    requireManagerJson(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('returns a JSON 403 when access level is MOD (1)', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.MOD } } });
    const res = makeRes();
    requireManagerJson(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'forbidden' });
    expect(res.render).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns a JSON 403 when no session user', () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    requireManagerJson(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'forbidden' });
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── requireAdminJson ──────────────────────────────────────────────────────────

describe('requireAdminJson', () => {
  it('calls next() when access level is ADMIN (3)', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.ADMIN } } });
    requireAdminJson(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('returns a JSON 403 when access level is MANAGER (2)', () => {
    const req = makeReq({ session: { user: { accessLevel: AccessLevel.MANAGER } } });
    const res = makeRes();
    requireAdminJson(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'forbidden' });
    expect(res.render).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns a JSON 403 when no session user', () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    requireAdminJson(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'forbidden' });
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── requireApiKey ────────────────────────────────────────────────────────────

describe('requireApiKey', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const req = makeReq({ headers: {} });
    const res = makeRes();
    await requireApiKey(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header does not start with Bearer', async () => {
    const req = makeReq({ headers: { authorization: 'Basic abc' } });
    const res = makeRes();
    await requireApiKey(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when findKeyByHash returns null', async () => {
    vi.mocked(findKeyByHash).mockResolvedValue(null);
    const req = makeReq({ headers: { authorization: 'Bearer mytoken' } });
    const res = makeRes();
    await requireApiKey(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('sets req.apiKeyOwner and calls next() when key is valid', async () => {
    vi.mocked(findKeyByHash).mockResolvedValue({ discordId: 'user42' } as any);
    const req = makeReq({ headers: { authorization: 'Bearer validtoken' } });
    const res = makeRes();
    await requireApiKey(req, res, next);
    expect(req.apiKeyOwner).toBe('user42');
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('hashes the token before looking it up', async () => {
    vi.mocked(findKeyByHash).mockResolvedValue({ discordId: 'u1' } as any);
    const req = makeReq({ headers: { authorization: 'Bearer mytoken' } });
    await requireApiKey(req, makeRes(), next);
    const passedHash: string = vi.mocked(findKeyByHash).mock.calls[0][0];
    // SHA256 of 'mytoken' is a 64-char hex string
    expect(passedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(passedHash).not.toBe('mytoken');
  });

  it('returns 500 when findKeyByHash throws', async () => {
    vi.mocked(findKeyByHash).mockRejectedValue(new Error('DB error'));
    const req = makeReq({ headers: { authorization: 'Bearer tok' } });
    const res = makeRes();
    await requireApiKey(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Internal server error' });
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── requireCompanionKey ─────────────────────────────────────────────────────

describe('requireCompanionKey', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const req = makeReq({ headers: {} });
    const res = makeRes();
    await requireCompanionKey(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header does not start with Bearer', async () => {
    const req = makeReq({ headers: { authorization: 'Basic abc' } });
    const res = makeRes();
    await requireCompanionKey(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when findDiscordIdByTokenHash returns null (missing/invalid/revoked)', async () => {
    vi.mocked(findDiscordIdByTokenHash).mockResolvedValue(null);
    const req = makeReq({ headers: { authorization: 'Bearer mytoken' } });
    const res = makeRes();
    await requireCompanionKey(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('sets req.companionDiscordId and calls next() when token is valid', async () => {
    vi.mocked(findDiscordIdByTokenHash).mockResolvedValue('user42');
    const req = makeReq({ headers: { authorization: 'Bearer validtoken' } });
    const res = makeRes();
    await requireCompanionKey(req, res, next);
    expect(req.companionDiscordId).toBe('user42');
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('also sets req.companionTokenHash to the hash of the presented token', async () => {
    vi.mocked(findDiscordIdByTokenHash).mockResolvedValue('user42');
    const req = makeReq({ headers: { authorization: 'Bearer validtoken' } });
    await requireCompanionKey(req, makeRes(), next);
    expect(req.companionTokenHash).toBe(createHash('sha256').update('validtoken').digest('hex'));
  });

  it('hashes the token before looking it up', async () => {
    vi.mocked(findDiscordIdByTokenHash).mockResolvedValue('u1');
    const req = makeReq({ headers: { authorization: 'Bearer mytoken' } });
    await requireCompanionKey(req, makeRes(), next);
    const passedHash: string = vi.mocked(findDiscordIdByTokenHash).mock.calls[0][0];
    expect(passedHash).toBe(createHash('sha256').update('mytoken').digest('hex'));
    expect(passedHash).not.toBe('mytoken');
  });

  it('returns 500 when findDiscordIdByTokenHash throws', async () => {
    vi.mocked(findDiscordIdByTokenHash).mockRejectedValue(new Error('DB error'));
    const req = makeReq({ headers: { authorization: 'Bearer tok' } });
    const res = makeRes();
    await requireCompanionKey(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Internal server error' });
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── requireGuildContext ────────────────────────────────────────────────────

describe('requireGuildContext', () => {
  beforeEach(() => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: 'u1', is_owner: false } as any);
  });

  it('redirects to login when no session user', async () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    await requireGuildContext(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith('/auth/login');
    expect(next).not.toHaveBeenCalled();
  });

  it('redirects to login when the session user no longer exists in the database', async () => {
    vi.mocked(findUser).mockResolvedValue(null);
    const user = { discordId: 'u1', currentGuildId: 'g1', accessLevel: AccessLevel.MANAGER, guilds: [{ guildId: 'g1', name: 'A' }] };
    const req = makeReq({ session: { user } });
    const res = makeRes();
    await requireGuildContext(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith('/auth/login');
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when a valid current guild is already selected, refreshing the access level from the membership list', async () => {
    vi.mocked(getGuildsForMember).mockResolvedValue([{ guild_id: 'g1', name: 'A', voice_channel_id: null, access_level: AccessLevel.ADMIN }] as any);
    const user = { discordId: 'u1', currentGuildId: 'g1', accessLevel: AccessLevel.MANAGER, guilds: [{ guildId: 'g1', name: 'A' }] };
    const req = makeReq({ session: { user } });
    await requireGuildContext(req, makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
    // Non-owner: the access level comes from getGuildsForMember's own access_level column,
    // not a second getEffectiveAccessLevelForUser query.
    expect(vi.mocked(getEffectiveAccessLevelForUser)).not.toHaveBeenCalled();
    expect(user.accessLevel).toBe(AccessLevel.ADMIN);
  });

  it('re-derives guild membership from the database, ignoring a stale session guild list', async () => {
    // Session cache claims membership in g2 too, but the live DB lookup only returns g1 —
    // the live data must win so a revoked membership takes effect immediately.
    vi.mocked(getGuildsForMember).mockResolvedValue([{ guild_id: 'g1', name: 'A', voice_channel_id: null, access_level: AccessLevel.MOD }] as any);
    const user = {
      discordId: 'u1',
      currentGuildId: 'g1',
      accessLevel: AccessLevel.ADMIN,
      guilds: [{ guildId: 'g1', name: 'A' }, { guildId: 'g2', name: 'B' }],
    };
    const req = makeReq({ session: { user } });
    await requireGuildContext(req, makeRes(), next);
    expect(user.guilds).toEqual([{ guildId: 'g1', name: 'A' }]);
    expect(next).toHaveBeenCalledOnce();
  });

  it('uses getAllGuilds instead of getGuildsForMember when the database reports the user as owner', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: 'u1', is_owner: true } as any);
    vi.mocked(getAllGuilds).mockResolvedValue([{ guild_id: 'g1', name: 'A', voice_channel_id: null }] as any);
    vi.mocked(getEffectiveAccessLevelForUser).mockResolvedValue(AccessLevel.ADMIN);
    const user = { discordId: 'u1', currentGuildId: 'g1', accessLevel: AccessLevel.USER, isOwner: false, guilds: [{ guildId: 'g1', name: 'A' }] };
    const req = makeReq({ session: { user } });
    await requireGuildContext(req, makeRes(), next);
    expect(user.isOwner).toBe(true);
    expect(vi.mocked(getAllGuilds)).toHaveBeenCalled();
    expect(vi.mocked(getGuildsForMember)).not.toHaveBeenCalled();
  });

  it('auto-selects and recomputes the level when the user has exactly one guild', async () => {
    vi.mocked(getGuildsForMember).mockResolvedValue([{ guild_id: 'g1', name: 'A', voice_channel_id: null, access_level: AccessLevel.ADMIN }] as any);
    const user = { discordId: 'u1', currentGuildId: null, accessLevel: AccessLevel.USER, guilds: [{ guildId: 'g1', name: 'A' }] };
    const req = makeReq({ session: { user } });
    await requireGuildContext(req, makeRes(), next);
    expect(user.currentGuildId).toBe('g1');
    expect(user.accessLevel).toBe(AccessLevel.ADMIN);
    expect(next).toHaveBeenCalledOnce();
  });

  it('redirects to the picker when multiple guilds and none selected', async () => {
    vi.mocked(getGuildsForMember).mockResolvedValue([
      { guild_id: 'g1', name: 'A', voice_channel_id: null },
      { guild_id: 'g2', name: 'B', voice_channel_id: null },
    ] as any);
    const req = makeReq({
      session: { user: { discordId: 'u1', currentGuildId: null, accessLevel: AccessLevel.USER, guilds: [{ guildId: 'g1', name: 'A' }, { guildId: 'g2', name: 'B' }] } },
    });
    const res = makeRes();
    await requireGuildContext(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith('/guild/select');
    expect(next).not.toHaveBeenCalled();
  });

  it('drops a stale guild the user no longer belongs to and re-picks', async () => {
    // currentGuildId points at a guild absent from the (now-reduced) membership list.
    vi.mocked(getGuildsForMember).mockResolvedValue([
      { guild_id: 'g1', name: 'A', voice_channel_id: null },
      { guild_id: 'g2', name: 'B', voice_channel_id: null },
    ] as any);
    const req = makeReq({
      session: { user: { discordId: 'u1', currentGuildId: 'gone', accessLevel: AccessLevel.ADMIN, guilds: [{ guildId: 'g1', name: 'A' }, { guildId: 'g2', name: 'B' }] } },
    });
    const res = makeRes();
    await requireGuildContext(req, res, next);
    expect(req.session.user.currentGuildId).toBeNull();
    expect(res.redirect).toHaveBeenCalledWith('/guild/select');
    expect(next).not.toHaveBeenCalled();
  });

  it('redirects to login when the user has no accessible guilds', async () => {
    vi.mocked(getGuildsForMember).mockResolvedValue([] as any);
    const req = makeReq({
      session: { user: { discordId: 'u1', currentGuildId: null, accessLevel: AccessLevel.USER, guilds: [] } },
    });
    const res = makeRes();
    await requireGuildContext(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith('/auth/login');
    expect(next).not.toHaveBeenCalled();
  });
});
