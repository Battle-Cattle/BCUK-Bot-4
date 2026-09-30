import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { insertPasskey, deletePasskey, listPasskeyDescriptorsForUser } from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { logAndRedirectError } from './errorHandling';
import {
  RP_NAME,
  RP_ID,
  EXPECTED_ORIGIN,
  chooseUserHandle,
  hasRecentDiscordAuth,
  storeChallenge,
  takeRegistrationChallenge,
  isCredentialResponse,
  sanitizeDeviceLabel,
} from './passkeysShared';

const log = createLogger('Web');
const router = Router();

const MAX_PASSKEYS_PER_USER = 10;
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

// ─── Registration (signed-in users add a passkey from User Settings) ─────────

/**
 * POST /auth/passkey/register/options — generates WebAuthn registration options for the
 * signed-in user, requiring a discoverable, user-verified (fingerprint/face/PIN) credential.
 * The session must have signed in with Discord within the last few minutes (step-up
 * re-authentication, see `hasRecentDiscordAuth`); /register/verify checks this again.
 * @param req - Express request; requires an authenticated session and CSRF token.
 * @param res - Express response; JSON registration options, 403 `{ error: 'passkey_reauth_required' }`
 *   when the last Discord login is too old, 409 `{ error: 'passkey_limit' }` when the user already
 *   has the maximum number of passkeys, or 500 on failure.
 */
router.post('/register/options', requireAuth, csrfProtection, async (req, res) => {
  if (!hasRecentDiscordAuth(req)) {
    res.status(403).json({ ok: false, error: 'passkey_reauth_required' });
    return;
  }
  try {
    const user = getSessionUser(req);
    const existing = await listPasskeyDescriptorsForUser(user.discordId);
    if (existing.length >= MAX_PASSKEYS_PER_USER) {
      res.status(409).json({ ok: false, error: 'passkey_limit' });
      return;
    }

    const userHandle = chooseUserHandle(existing);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: new Uint8Array(Buffer.from(userHandle, 'base64url')),
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
    await storeChallenge(req, 'register', options.challenge, { discordId: user.discordId, userHandle });
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
 * @param res - Express response; `{ ok: true }` on success, 403 `{ error: 'passkey_reauth_required' }`
 *   when the last Discord login is no longer recent, 400 `{ error: 'passkey_register_failed' }`
 *   when the challenge or response is invalid, 409 `{ error: 'passkey_exists' }` for an
 *   already-registered credential, 409 `{ error: 'passkey_limit' }` if the user reached the
 *   passkey limit since requesting options, or 500 on an unexpected failure.
 */
router.post('/register/verify', requireAuth, csrfProtection, async (req, res) => {
  // Re-checked here, not only at /register/options, so the recent-Discord-login requirement
  // holds when the credential is actually persisted.
  if (!hasRecentDiscordAuth(req)) {
    res.status(403).json({ ok: false, error: 'passkey_reauth_required' });
    return;
  }
  const user = getSessionUser(req);
  const body = req.body as { response?: unknown; label?: unknown } | undefined;
  let challenge;
  try {
    challenge = await takeRegistrationChallenge(req, user.discordId);
  } catch (err) {
    log.error('Passkey registration challenge error:', err);
    res.status(500).json({ ok: false, error: 'passkey_register_failed' });
    return;
  }
  if (!challenge || !isCredentialResponse(body?.response)) {
    res.status(400).json({ ok: false, error: 'passkey_register_failed' });
    return;
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.value,
      expectedOrigin: EXPECTED_ORIGIN,
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
    const result = await insertPasskey({
      credentialId: credential.id,
      discordId: user.discordId,
      userHandle: challenge.userHandle,
      publicKey: credential.publicKey,
      signCount: credential.counter,
      transports: credential.transports ?? [],
      deviceLabel: sanitizeDeviceLabel(body.label),
    }, MAX_PASSKEYS_PER_USER);
    if (result !== 'inserted') {
      // 'limit' re-checks the count atomically with the insert, since the check in
      // /register/options can be raced by two registrations started in parallel.
      res.status(409).json({ ok: false, error: result === 'limit' ? 'passkey_limit' : 'passkey_exists' });
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

export default router;
