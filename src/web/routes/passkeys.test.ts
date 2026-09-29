import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../shared/config', () => ({
  PUBLIC_URL: 'https://panel.example.com',
  SESSION_SECRET: 's'.repeat(32),
}));
vi.mock('../../db', () => ({
  findUser: vi.fn(),
  findPasskey: vi.fn(),
  insertPasskey: vi.fn(),
  recordPasskeyUse: vi.fn(),
  deletePasskey: vi.fn(),
  listPasskeyDescriptorsForUser: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));
vi.mock('../../discord/discordBot', () => ({ fetchDiscordUserProfile: vi.fn() }));
vi.mock('./auth', () => ({
  resolveAccessibleGuilds: vi.fn(),
  establishDashboardSession: vi.fn(),
}));
vi.mock('../csrf', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../middleware', () => ({
  requireAuth: (req: any, res: any, next: any) => (req.session.user ? next() : res.redirect('/auth/login')),
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import express from 'express';
import supertest from 'supertest';
import router, { sanitizeDeviceLabel, webauthnUserHandle } from './passkeys';
import {
  findUser,
  findPasskey,
  insertPasskey,
  recordPasskeyUse,
  deletePasskey,
  listPasskeyDescriptorsForUser,
} from '../../db';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { fetchDiscordUserProfile } from '../../discord/discordBot';
import { resolveAccessibleGuilds, establishDashboardSession } from './auth';
import { makeSessionUser } from '../../test-utils/fixtures';

const USER = makeSessionUser({ discordId: '42', discordName: 'Alice' });
const CREDENTIAL = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {} };

/** Builds an app with a plain-object session (shared across requests so challenges persist), exposing it for assertions. */
function buildApp(initialSession: Record<string, unknown> = {}) {
  const session: Record<string, unknown> = { ...initialSession };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req: any, _res, next) => {
    req.session = session;
    next();
  });
  app.use(router);
  return { app, session };
}

function futureChallenge(purpose: 'register' | 'login', extra: Record<string, unknown> = {}) {
  return { webauthnChallenge: { purpose, value: 'chal', expiresAt: Date.now() + 60_000, ...extra } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPasskeyDescriptorsForUser).mockResolvedValue([]);
  vi.mocked(generateRegistrationOptions).mockResolvedValue({ challenge: 'reg-chal' } as any);
  vi.mocked(generateAuthenticationOptions).mockResolvedValue({ challenge: 'auth-chal' } as any);
  vi.mocked(insertPasskey).mockResolvedValue(true);
  vi.mocked(deletePasskey).mockResolvedValue(true);
  vi.mocked(fetchDiscordUserProfile).mockResolvedValue({ username: 'alice', avatar: 'av' });
  vi.mocked(resolveAccessibleGuilds).mockResolvedValue([{ guild_id: 'g1' }] as any);
  vi.mocked(establishDashboardSession).mockResolvedValue(undefined);
});

describe('webauthnUserHandle', () => {
  it('is stable per user, differs between users, and does not embed the Discord ID', () => {
    const a = Buffer.from(webauthnUserHandle('42'));
    expect(a).toHaveLength(32);
    expect(Buffer.from(webauthnUserHandle('42')).equals(a)).toBe(true);
    expect(Buffer.from(webauthnUserHandle('43')).equals(a)).toBe(false);
    expect(a.toString('utf8')).not.toContain('42');
  });
});

describe('sanitizeDeviceLabel', () => {
  it('trims, collapses whitespace and truncates to 100 chars', () => {
    expect(sanitizeDeviceLabel('  My\n  Phone ')).toBe('My Phone');
    expect(sanitizeDeviceLabel('x'.repeat(150))).toHaveLength(100);
  });

  it('falls back to "Passkey" for blank or non-string input', () => {
    expect(sanitizeDeviceLabel('   ')).toBe('Passkey');
    expect(sanitizeDeviceLabel(['a'])).toBe('Passkey');
    expect(sanitizeDeviceLabel(undefined)).toBe('Passkey');
  });
});

// ─── Registration ─────────────────────────────────────────────────────────────

describe('POST /register/options', () => {
  it('redirects to login without a session user', async () => {
    const { app } = buildApp();
    const res = await supertest(app).post('/register/options');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });

  it('returns options requiring a user-verified discoverable credential and stores the challenge', async () => {
    vi.mocked(listPasskeyDescriptorsForUser).mockResolvedValue([{ credentialId: 'old', transports: ['internal'] }]);
    const { app, session } = buildApp({ user: USER });

    const res = await supertest(app).post('/register/options');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: 'reg-chal' });
    const opts = vi.mocked(generateRegistrationOptions).mock.calls[0][0];
    expect(opts.rpID).toBe('panel.example.com');
    expect(opts.authenticatorSelection).toEqual({ residentKey: 'required', userVerification: 'required' });
    expect(opts.excludeCredentials).toEqual([{ id: 'old', transports: ['internal'] }]);
    expect(Buffer.from(opts.userID!).equals(Buffer.from(webauthnUserHandle('42')))).toBe(true);
    expect(session.webauthnChallenge).toMatchObject({ purpose: 'register', value: 'reg-chal', discordId: '42' });
  });

  it('refuses with passkey_limit once the user has 10 passkeys', async () => {
    vi.mocked(listPasskeyDescriptorsForUser).mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ credentialId: `c${i}`, transports: [] })),
    );
    const { app } = buildApp({ user: USER });
    const res = await supertest(app).post('/register/options');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('passkey_limit');
    expect(generateRegistrationOptions).not.toHaveBeenCalled();
  });
});

describe('POST /register/verify', () => {
  const verified = {
    verified: true,
    registrationInfo: { credential: { id: 'new-cred', publicKey: new Uint8Array([1, 2]), counter: 0, transports: ['internal'] } },
  };

  it('stores the verified passkey with a sanitised label and consumes the challenge', async () => {
    vi.mocked(verifyRegistrationResponse).mockResolvedValue(verified as any);
    const { app, session } = buildApp({ user: USER, ...futureChallenge('register', { discordId: '42' }) });

    const res = await supertest(app).post('/register/verify').send({ response: CREDENTIAL, label: '  Pixel  ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(vi.mocked(verifyRegistrationResponse).mock.calls[0][0]).toMatchObject({
      expectedChallenge: 'chal',
      expectedOrigin: 'https://panel.example.com',
      expectedRPID: 'panel.example.com',
      requireUserVerification: true,
    });
    expect(insertPasskey).toHaveBeenCalledWith({
      credentialId: 'new-cred',
      discordId: '42',
      publicKey: new Uint8Array([1, 2]),
      signCount: 0,
      transports: ['internal'],
      deviceLabel: 'Pixel',
    });
    expect(session.webauthnChallenge).toBeUndefined();
  });

  it('rejects when there is no pending registration challenge', async () => {
    const { app } = buildApp({ user: USER });
    const res = await supertest(app).post('/register/verify').send({ response: CREDENTIAL });
    expect(res.status).toBe(400);
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('rejects an expired challenge', async () => {
    const { app } = buildApp({
      user: USER,
      webauthnChallenge: { purpose: 'register', value: 'chal', discordId: '42', expiresAt: Date.now() - 1 },
    });
    const res = await supertest(app).post('/register/verify').send({ response: CREDENTIAL });
    expect(res.status).toBe(400);
  });

  it('rejects a login challenge used for registration', async () => {
    const { app } = buildApp({ user: USER, ...futureChallenge('login') });
    const res = await supertest(app).post('/register/verify').send({ response: CREDENTIAL });
    expect(res.status).toBe(400);
  });

  it('rejects a challenge issued to a different user', async () => {
    const { app } = buildApp({ user: USER, ...futureChallenge('register', { discordId: '99' }) });
    const res = await supertest(app).post('/register/verify').send({ response: CREDENTIAL });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed response body', async () => {
    const { app } = buildApp({ user: USER, ...futureChallenge('register', { discordId: '42' }) });
    const res = await supertest(app).post('/register/verify').send({ response: 'nope' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when verification throws', async () => {
    vi.mocked(verifyRegistrationResponse).mockRejectedValue(new Error('bad origin'));
    const { app } = buildApp({ user: USER, ...futureChallenge('register', { discordId: '42' }) });
    const res = await supertest(app).post('/register/verify').send({ response: CREDENTIAL });
    expect(res.status).toBe(400);
    expect(insertPasskey).not.toHaveBeenCalled();
  });

  it('returns 409 passkey_exists when the credential is already stored', async () => {
    vi.mocked(verifyRegistrationResponse).mockResolvedValue(verified as any);
    vi.mocked(insertPasskey).mockResolvedValue(false);
    const { app } = buildApp({ user: USER, ...futureChallenge('register', { discordId: '42' }) });
    const res = await supertest(app).post('/register/verify').send({ response: CREDENTIAL });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('passkey_exists');
  });
});

describe('POST /delete', () => {
  it("deletes the user's own passkey and redirects with success", async () => {
    const { app } = buildApp({ user: USER });
    const res = await supertest(app).post('/delete').type('form').send({ credentialId: 'cred-1' });
    expect(deletePasskey).toHaveBeenCalledWith('42', 'cred-1');
    expect(res.headers.location).toBe('/user/settings?success=passkey_removed');
  });

  it('redirects with an error when no passkey of the user matched', async () => {
    vi.mocked(deletePasskey).mockResolvedValue(false);
    const { app } = buildApp({ user: USER });
    const res = await supertest(app).post('/delete').type('form').send({ credentialId: 'someone-elses' });
    expect(res.headers.location).toBe('/user/settings?error=passkey_delete_failed');
  });

  it('rejects a malformed credential ID without touching the DB', async () => {
    const { app } = buildApp({ user: USER });
    const res = await supertest(app).post('/delete').type('form').send({ credentialId: 'bad id!' });
    expect(res.headers.location).toBe('/user/settings?error=passkey_delete_failed');
    expect(deletePasskey).not.toHaveBeenCalled();
  });

  it('redirects with an error when the delete throws', async () => {
    vi.mocked(deletePasskey).mockRejectedValue(new Error('db down'));
    const { app } = buildApp({ user: USER });
    const res = await supertest(app).post('/delete').type('form').send({ credentialId: 'cred-1' });
    expect(res.headers.location).toBe('/user/settings?error=passkey_delete_failed');
  });
});

// ─── Sign-in ──────────────────────────────────────────────────────────────────

describe('POST /login/options', () => {
  it('returns user-verification-required options without a session user and stores the challenge', async () => {
    const { app, session } = buildApp();
    const res = await supertest(app).post('/login/options');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: 'auth-chal' });
    expect(generateAuthenticationOptions).toHaveBeenCalledWith({ rpID: 'panel.example.com', userVerification: 'required' });
    expect(session.webauthnChallenge).toMatchObject({ purpose: 'login', value: 'auth-chal' });
  });
});

describe('POST /login/verify', () => {
  const stored = {
    credentialId: 'cred-1',
    discordId: '42',
    publicKey: new Uint8Array([1]),
    signCount: 3,
    transports: ['internal'],
  };
  const dbUser = { discord_id: '42', discord_name: 'Alice', is_owner: false };

  beforeEach(() => {
    vi.mocked(findPasskey).mockResolvedValue(stored);
    vi.mocked(findUser).mockResolvedValue(dbUser as any);
    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 4 },
    } as any);
  });

  it('verifies the assertion, bumps the counter and creates the dashboard session', async () => {
    const { app, session } = buildApp(futureChallenge('login'));

    const res = await supertest(app).post('/login/verify').send({ response: CREDENTIAL });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, redirect: '/' });
    expect(vi.mocked(verifyAuthenticationResponse).mock.calls[0][0]).toMatchObject({
      expectedChallenge: 'chal',
      expectedOrigin: 'https://panel.example.com',
      expectedRPID: 'panel.example.com',
      requireUserVerification: true,
      credential: { id: 'cred-1', counter: 3 },
    });
    expect(recordPasskeyUse).toHaveBeenCalledWith('cred-1', 4);
    expect(establishDashboardSession).toHaveBeenCalledWith(
      expect.anything(),
      { id: '42', username: 'alice', avatar: 'av' },
      dbUser,
      [{ guild_id: 'g1' }],
    );
    expect(session.webauthnChallenge).toBeUndefined();
  });

  it('falls back to the stored name and no avatar when the bot cannot fetch the profile', async () => {
    vi.mocked(fetchDiscordUserProfile).mockResolvedValue(null);
    const { app } = buildApp(futureChallenge('login'));
    await supertest(app).post('/login/verify').send({ response: CREDENTIAL });
    expect(vi.mocked(establishDashboardSession).mock.calls[0][1]).toEqual({ id: '42', username: 'Alice', avatar: null });
  });

  it('rejects without a pending login challenge', async () => {
    const { app } = buildApp();
    const res = await supertest(app).post('/login/verify').send({ response: CREDENTIAL });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('passkey_failed');
    expect(findPasskey).not.toHaveBeenCalled();
  });

  it('rejects a registration challenge used for sign-in', async () => {
    const { app } = buildApp(futureChallenge('register', { discordId: '42' }));
    const res = await supertest(app).post('/login/verify').send({ response: CREDENTIAL });
    expect(res.status).toBe(400);
  });

  it('does not allow the same challenge to be verified twice', async () => {
    const { app } = buildApp(futureChallenge('login'));
    await supertest(app).post('/login/verify').send({ response: CREDENTIAL });
    const replay = await supertest(app).post('/login/verify').send({ response: CREDENTIAL });
    expect(replay.status).toBe(400);
    expect(establishDashboardSession).toHaveBeenCalledTimes(1);
  });

  it('returns passkey_unknown for an unregistered credential', async () => {
    vi.mocked(findPasskey).mockResolvedValue(null);
    const { app } = buildApp(futureChallenge('login'));
    const res = await supertest(app).post('/login/verify').send({ response: CREDENTIAL });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('passkey_unknown');
  });

  it('rejects an assertion whose user handle belongs to a different user', async () => {
    const otherHandle = Buffer.from(webauthnUserHandle('99')).toString('base64url');
    const { app } = buildApp(futureChallenge('login'));
    const res = await supertest(app)
      .post('/login/verify')
      .send({ response: { ...CREDENTIAL, response: { userHandle: otherHandle } } });
    expect(res.status).toBe(401);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('accepts an assertion carrying the matching user handle', async () => {
    const handle = Buffer.from(webauthnUserHandle('42')).toString('base64url');
    const { app } = buildApp(futureChallenge('login'));
    const res = await supertest(app)
      .post('/login/verify')
      .send({ response: { ...CREDENTIAL, response: { userHandle: handle } } });
    expect(res.status).toBe(200);
  });

  it('returns passkey_failed when signature verification throws, without creating a session', async () => {
    vi.mocked(verifyAuthenticationResponse).mockRejectedValue(new Error('bad signature'));
    const { app } = buildApp(futureChallenge('login'));
    const res = await supertest(app).post('/login/verify').send({ response: CREDENTIAL });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('passkey_failed');
    expect(recordPasskeyUse).not.toHaveBeenCalled();
    expect(establishDashboardSession).not.toHaveBeenCalled();
  });

  it('still signs in when recording the counter fails after a verified assertion', async () => {
    vi.mocked(recordPasskeyUse).mockRejectedValueOnce(new Error('db write failed'));
    const { app } = buildApp(futureChallenge('login'));
    const res = await supertest(app).post('/login/verify').send({ response: CREDENTIAL });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, redirect: '/' });
    expect(establishDashboardSession).toHaveBeenCalledTimes(1);
  });

  it('returns not_whitelisted when the user has since been removed', async () => {
    vi.mocked(findUser).mockResolvedValue(null);
    const { app } = buildApp(futureChallenge('login'));
    const res = await supertest(app).post('/login/verify').send({ response: CREDENTIAL });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_whitelisted');
    expect(establishDashboardSession).not.toHaveBeenCalled();
  });

  it('returns no_guilds when the user has no accessible guild', async () => {
    vi.mocked(resolveAccessibleGuilds).mockResolvedValue([]);
    const { app } = buildApp(futureChallenge('login'));
    const res = await supertest(app).post('/login/verify').send({ response: CREDENTIAL });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_guilds');
  });

  it('returns 500 passkey_failed when session creation fails', async () => {
    vi.mocked(establishDashboardSession).mockRejectedValue(new Error('store down'));
    const { app } = buildApp(futureChallenge('login'));
    const res = await supertest(app).post('/login/verify').send({ response: CREDENTIAL });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('passkey_failed');
  });
});
