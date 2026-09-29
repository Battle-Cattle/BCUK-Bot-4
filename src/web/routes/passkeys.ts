import { createLogger } from '../../shared/logger';
import { Router, type Request } from 'express';
import { createHmac } from 'crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { PUBLIC_URL, SESSION_SECRET } from '../../shared/config';
import {
  findUser,
  findPasskey,
  insertPasskey,
  recordPasskeyUse,
  deletePasskey,
  listPasskeyDescriptorsForUser,
  type DbUser,
  type StoredPasskey,
} from '../../db';
import { fetchDiscordUserProfile } from '../../discord/discordBot';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { logAndRedirectError } from './errorHandling';
import { resolveAccessibleGuilds, establishDashboardSession, type DiscordProfile } from './auth';

const log = createLogger('Web');
const router = Router();

const RP_NAME = 'BCUK Bot';
const RP_ID = new URL(PUBLIC_URL).hostname;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSKEYS_PER_USER = 10;
const DEVICE_LABEL_MAX_LENGTH = 100;
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

type ChallengePurpose = 'register' | 'login';

/**
 * Derives the opaque WebAuthn user handle for a Discord user: an HMAC of their Discord ID, so
 * the same user always gets the same handle (letting an authenticator replace rather than
 * duplicate a passkey) without storing the raw Discord ID on the authenticator.
 * @param discordId - The user's Discord ID.
 * @returns The 32-byte user handle.
 */
export function webauthnUserHandle(discordId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHmac('sha256', SESSION_SECRET).update(`webauthn-user:${discordId}`).digest());
}

/**
 * Stores a freshly-generated WebAuthn challenge on the session, replacing any earlier one.
 * @param req - Express request whose session receives the challenge.
 * @param purpose - Which ceremony the challenge is for, so a login challenge can't complete a registration.
 * @param value - The base64url challenge from the generated options.
 * @param discordId - For registration, the user the challenge was issued to.
 */
function storeChallenge(req: Request, purpose: ChallengePurpose, value: string, discordId?: string): void {
  req.session.webauthnChallenge = { purpose, value, discordId, expiresAt: Date.now() + CHALLENGE_TTL_MS };
}

/**
 * Removes the session's pending WebAuthn challenge and returns it if it is unexpired and for
 * `purpose`. Always consumes it, so each challenge can be used for at most one verification.
 * @param req - Express request whose session holds the challenge.
 * @param purpose - The ceremony being verified.
 * @returns The challenge (and bound Discord ID, for registration), or null if missing/expired/wrong purpose.
 */
function takeChallenge(req: Request, purpose: ChallengePurpose): { value: string; discordId?: string } | null {
  const stored = req.session.webauthnChallenge;
  delete req.session.webauthnChallenge;
  if (!stored || stored.purpose !== purpose || Date.now() > stored.expiresAt) return null;
  return { value: stored.value, discordId: stored.discordId };
}

/**
 * Checks that a request body field looks like a WebAuthn credential response JSON (an object
 * with a string `id` and a `response` object). Full validation is left to `@simplewebauthn/server`.
 * @param value - The submitted `response` body field.
 * @returns True if the value has the basic credential-response shape.
 */
function isCredentialResponse(value: unknown): value is { id: string; response: Record<string, unknown> } {
  if (!value || typeof value !== 'object') return false;
  const v = value as { id?: unknown; response?: unknown };
  return typeof v.id === 'string' && !!v.response && typeof v.response === 'object';
}

/**
 * Normalises the user-supplied passkey label: trimmed, collapsed to a single line, truncated.
 * @param raw - The submitted `label` body field.
 * @returns The label to store, or `'Passkey'` when blank or not a string.
 */
export function sanitizeDeviceLabel(raw: unknown): string {
  if (typeof raw !== 'string') return 'Passkey';
  const label = raw.replace(/\s+/g, ' ').trim().slice(0, DEVICE_LABEL_MAX_LENGTH);
  return label || 'Passkey';
}

// ─── Registration (signed-in users add a passkey from User Settings) ─────────

/**
 * POST /auth/passkey/register/options — generates WebAuthn registration options for the
 * signed-in user, requiring a discoverable, user-verified (fingerprint/face/PIN) credential.
 * @param req - Express request; requires an authenticated session and CSRF token.
 * @param res - Express response; JSON registration options, 409 `{ error: 'passkey_limit' }`
 *   when the user already has the maximum number of passkeys, or 500 on failure.
 */
router.post('/register/options', requireAuth, csrfProtection, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const existing = await listPasskeyDescriptorsForUser(user.discordId);
    if (existing.length >= MAX_PASSKEYS_PER_USER) {
      res.status(409).json({ ok: false, error: 'passkey_limit' });
      return;
    }

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: webauthnUserHandle(user.discordId),
      userName: user.discordName,
      userDisplayName: user.discordName,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransport[],
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      preferredAuthenticatorType: 'localDevice',
    });
    storeChallenge(req, 'register', options.challenge, user.discordId);
    res.json(options);
  } catch (err) {
    log.error('Passkey registration options error:', err);
    res.status(500).json({ ok: false, error: 'passkey_register_failed' });
  }
});

/**
 * POST /auth/passkey/register/verify — verifies the browser's registration response against
 * the session's pending challenge and stores the new passkey.
 * @param req - Express request; JSON body `{ response, label }`, requires an authenticated
 *   session and CSRF token.
 * @param res - Express response; `{ ok: true }` on success, 400 `{ error: 'passkey_register_failed' }`
 *   when the challenge or response is invalid, 409 `{ error: 'passkey_exists' }` for an
 *   already-registered credential, or 500 on an unexpected failure.
 */
router.post('/register/verify', requireAuth, csrfProtection, async (req, res) => {
  const user = getSessionUser(req);
  const body = req.body as { response?: unknown; label?: unknown } | undefined;
  const challenge = takeChallenge(req, 'register');
  if (!challenge || challenge.discordId !== user.discordId || !isCredentialResponse(body?.response)) {
    res.status(400).json({ ok: false, error: 'passkey_register_failed' });
    return;
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.value,
      expectedOrigin: PUBLIC_URL,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });
  } catch (err) {
    log.warn('Passkey registration verification failed:', err);
    res.status(400).json({ ok: false, error: 'passkey_register_failed' });
    return;
  }
  if (!verification.verified) {
    res.status(400).json({ ok: false, error: 'passkey_register_failed' });
    return;
  }

  try {
    const { credential } = verification.registrationInfo;
    const stored = await insertPasskey({
      credentialId: credential.id,
      discordId: user.discordId,
      publicKey: credential.publicKey,
      signCount: credential.counter,
      transports: credential.transports ?? [],
      deviceLabel: sanitizeDeviceLabel(body.label),
    });
    if (!stored) {
      res.status(409).json({ ok: false, error: 'passkey_exists' });
      return;
    }
    log.info(`Passkey registered for ${user.discordId}`);
    res.json({ ok: true });
  } catch (err) {
    log.error('Passkey registration save error:', err);
    res.status(500).json({ ok: false, error: 'passkey_register_failed' });
  }
});

/**
 * POST /auth/passkey/delete — removes one of the signed-in user's passkeys.
 * @param req - Express request; form body `credentialId`, requires an authenticated session and CSRF token.
 * @param res - Express response; redirects to `/user/settings?success=passkey_removed`, or to
 *   `/user/settings?error=passkey_delete_failed` if the ID is invalid, not the user's, or the delete fails.
 */
router.post('/delete', requireAuth, csrfProtection, async (req, res) => {
  try {
    const credentialId = (req.body as { credentialId?: unknown } | undefined)?.credentialId;
    if (typeof credentialId !== 'string' || !CREDENTIAL_ID_PATTERN.test(credentialId)) {
      res.redirect('/user/settings?error=passkey_delete_failed');
      return;
    }
    const deleted = await deletePasskey(getSessionUser(req).discordId, credentialId);
    res.redirect(deleted ? '/user/settings?success=passkey_removed' : '/user/settings?error=passkey_delete_failed');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Passkey delete error:', err, basePath: '/user/settings', errorCode: 'passkey_delete_failed' });
  }
});

// ─── Sign-in (login page, no session yet) ────────────────────────────────────
// No CSRF token here: there is no signed-in session to protect yet, and a cross-site page
// can't forge a sign-in — the assertion is bound to this origin and to the challenge held in
// the requester's own session cookie (sameSite=lax, so not sent on a cross-site POST).

/**
 * POST /auth/passkey/login/options — generates WebAuthn authentication options for a
 * discoverable-credential sign-in (no username needed; the browser offers the user's passkeys).
 * @param req - Express request; the challenge is stored on its session.
 * @param res - Express response; JSON authentication options, or 500 on failure.
 */
router.post('/login/options', async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'required' });
    storeChallenge(req, 'login', options.challenge);
    res.json(options);
  } catch (err) {
    log.error('Passkey login options error:', err);
    res.status(500).json({ ok: false, error: 'passkey_failed' });
  }
});

/** Outcome of checking a sign-in assertion: the verified passkey, or the HTTP status and login error code to reply with. */
type AssertionResult =
  | { ok: true; passkey: StoredPasskey }
  | { ok: false; status: number; error: 'passkey_failed' | 'passkey_unknown' };

/**
 * Verifies a sign-in assertion against its stored passkey and the session's challenge, then
 * records the authenticator's new signature counter (best-effort: a failed write is logged, not fatal).
 * @param assertion - The browser's `navigator.credentials.get()` result.
 * @param expectedChallenge - The challenge taken from the session.
 * @returns The verified passkey, or the failure status/code to reply with.
 */
async function verifyAssertion(assertion: AuthenticationResponseJSON, expectedChallenge: string): Promise<AssertionResult> {
  const passkey = await findPasskey(assertion.id);
  if (!passkey) return { ok: false, status: 401, error: 'passkey_unknown' };

  const expectedHandle = Buffer.from(webauthnUserHandle(passkey.discordId)).toString('base64url');
  if (assertion.response.userHandle && assertion.response.userHandle !== expectedHandle) {
    log.warn(`Passkey ${passkey.credentialId} presented a mismatched user handle`);
    return { ok: false, status: 401, error: 'passkey_failed' };
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge,
      expectedOrigin: PUBLIC_URL,
      expectedRPID: RP_ID,
      credential: {
        id: passkey.credentialId,
        publicKey: passkey.publicKey,
        counter: passkey.signCount,
        transports: passkey.transports as AuthenticatorTransport[],
      },
      requireUserVerification: true,
    });
  } catch (err) {
    log.warn('Passkey assertion verification failed:', err);
    return { ok: false, status: 401, error: 'passkey_failed' };
  }
  if (!verification.verified) return { ok: false, status: 401, error: 'passkey_failed' };

  // Best-effort: the assertion is already verified, so a failed bookkeeping write (counter,
  // last_used_at) shouldn't turn a valid sign-in into an error.
  try {
    await recordPasskeyUse(passkey.credentialId, verification.authenticationInfo.newCounter);
  } catch (err) {
    log.warn(`Failed to record use of passkey ${passkey.credentialId}:`, err);
  }
  return { ok: true, passkey };
}

/**
 * Rebuilds the Discord profile a passkey sign-in has no OAuth response for, via the bot client,
 * falling back to the stored name and the default avatar if the bot can't fetch it.
 * @param dbUser - The signing-in user's row.
 * @returns The profile to build the session from.
 */
async function loadDiscordProfile(dbUser: DbUser): Promise<DiscordProfile> {
  const fetched = await fetchDiscordUserProfile(dbUser.discord_id);
  return {
    id: dbUser.discord_id,
    username: fetched?.username ?? dbUser.discord_name ?? dbUser.discord_id,
    avatar: fetched?.avatar ?? null,
  };
}

/**
 * POST /auth/passkey/login/verify — verifies a passkey assertion and, if it belongs to a
 * still-whitelisted user with at least one accessible guild, creates the same dashboard
 * session a Discord login would.
 * @param req - Express request; JSON body `{ response }` from `navigator.credentials.get()`.
 * @param res - Express response; `{ ok: true, redirect: '/' }` on success, otherwise a 4xx/5xx
 *   `{ ok: false, error }` with a code `GET /auth/login?error=` understands: `passkey_failed`
 *   (bad/expired challenge or signature), `passkey_unknown` (credential not registered),
 *   `not_whitelisted`, or `no_guilds`.
 */
router.post('/login/verify', async (req, res) => {
  const response = (req.body as { response?: unknown } | undefined)?.response;
  const challenge = takeChallenge(req, 'login');
  if (!challenge || !isCredentialResponse(response)) {
    res.status(400).json({ ok: false, error: 'passkey_failed' });
    return;
  }

  try {
    const result = await verifyAssertion(response as unknown as AuthenticationResponseJSON, challenge.value);
    if (!result.ok) {
      res.status(result.status).json({ ok: false, error: result.error });
      return;
    }
    const { discordId } = result.passkey;

    const dbUser = await findUser(discordId);
    if (!dbUser) {
      res.status(403).json({ ok: false, error: 'not_whitelisted' });
      return;
    }
    const accessibleGuilds = await resolveAccessibleGuilds(dbUser);
    if (accessibleGuilds.length === 0) {
      res.status(403).json({ ok: false, error: 'no_guilds' });
      return;
    }

    await establishDashboardSession(req, await loadDiscordProfile(dbUser), dbUser, accessibleGuilds);
    res.json({ ok: true, redirect: '/' });
  } catch (err) {
    log.error('Passkey login error:', err);
    res.status(500).json({ ok: false, error: 'passkey_failed' });
  }
});

export default router;
