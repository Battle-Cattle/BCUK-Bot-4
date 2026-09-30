import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
} from '@simplewebauthn/server';
import { findUser, findPasskey, recordPasskeyUse, type DbUser, type StoredPasskey } from '../../db';
import { fetchDiscordUserProfile } from '../../discord/discordBot';
import { resolveAccessibleGuilds, establishDashboardSession, type DiscordProfile } from './auth';
import { RP_ID, EXPECTED_ORIGIN, storeChallenge, takeChallenge, isCredentialResponse } from './passkeysShared';

const log = createLogger('Web');
const router = Router();

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
    await storeChallenge(req, 'login', options.challenge);
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
 * records the authenticator's new signature counter. The counter write is required: if it fails,
 * this throws rather than letting the sign-in through.
 * @param assertion - The browser's `navigator.credentials.get()` result.
 * @param expectedChallenge - The challenge taken from the session.
 * @returns The verified passkey, or the failure status/code to reply with.
 * @throws If the passkey lookup or the counter/last-used write fails.
 */
async function verifyAssertion(assertion: AuthenticationResponseJSON, expectedChallenge: string): Promise<AssertionResult> {
  const passkey = await findPasskey(assertion.id);
  if (!passkey) return { ok: false, status: 401, error: 'passkey_unknown' };

  if (assertion.response.userHandle && assertion.response.userHandle !== passkey.userHandle) {
    log.warn(`Passkey ${passkey.credentialId} presented a mismatched user handle`);
    return { ok: false, status: 401, error: 'passkey_failed' };
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge,
      expectedOrigin: EXPECTED_ORIGIN,
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

  // Strict: the new signature counter must be persisted before the sign-in succeeds, or a cloned
  // authenticator could replay against the stale counter. A failed write throws, and the route
  // answers 500 `passkey_failed` without creating a session.
  await recordPasskeyUse(passkey.credentialId, verification.authenticationInfo.newCounter);
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
  try {
    const challenge = await takeChallenge(req, 'login');
    if (!challenge || !isCredentialResponse(response)) {
      res.status(400).json({ ok: false, error: 'passkey_failed' });
      return;
    }

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
