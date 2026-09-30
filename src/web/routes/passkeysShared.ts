import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { PUBLIC_URL } from '../../shared/config';
import { saveWebauthnChallenge, consumeWebauthnChallenge } from '../../db';

// Shared by the passkey registration (passkeysRegistration.ts) and sign-in (passkeysLogin.ts)
// routers: relying-party config, challenge storage/consumption, and request-shape helpers.

export const RP_NAME = 'BCUK Bot';
export const RP_ID = new URL(PUBLIC_URL).hostname;
export const EXPECTED_ORIGIN = PUBLIC_URL;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEVICE_LABEL_MAX_LENGTH = 100;
/** Most passkeys one user may register. */
export const MAX_PASSKEYS_PER_USER = 10;
/** How recently the user must have signed in with Discord (not a passkey) to add a passkey. */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

type ChallengePurpose = 'register' | 'login';

/**
 * Picks the WebAuthn user handle for a registration: the user's existing handle if they already
 * have a passkey (so every passkey of theirs shares one handle and an authenticator replaces
 * rather than duplicates it), otherwise a fresh random one. The handle is random and stored per
 * credential, not derived from a secret, so rotating any app secret never invalidates passkeys,
 * and it never exposes the Discord ID to the authenticator.
 * @param existing - The user's current passkey descriptors.
 * @returns The base64url user handle.
 */
export function chooseUserHandle(existing: { userHandle: string }[]): string {
  return existing[0]?.userHandle ?? randomBytes(32).toString('base64url');
}

/**
 * Whether this session completed a Discord OAuth login within {@link REAUTH_WINDOW_MS}. Adding a
 * passkey creates a long-lived credential, so it needs fresh proof of the Discord account rather
 * than just a (possibly old, or passkey-created) session — a hijacked session alone can't enrol one.
 * @param req - Express request whose session's `discordAuthAt` is checked.
 * @returns True if the last Discord login is recent enough.
 */
export function hasRecentDiscordAuth(req: Request): boolean {
  const at = req.session.discordAuthAt;
  return typeof at === 'number' && Date.now() - at <= REAUTH_WINDOW_MS;
}

/**
 * Records a freshly-generated WebAuthn challenge: in the DB (which makes it single-use, see
 * {@link takeChallenge}) and on the session (which binds it to this browser, replacing any
 * earlier one).
 * @param req - Express request whose session receives the challenge.
 * @param purpose - Which ceremony the challenge is for, so a login challenge can't complete a registration.
 * @param value - The base64url challenge from the generated options.
 * @param registration - For registration, the user the challenge was issued to and the user handle
 *   put in the options, so verify stores the same handle.
 * @returns Resolves once the challenge is persisted.
 */
export async function storeChallenge(
  req: Request,
  purpose: ChallengePurpose,
  value: string,
  registration?: { discordId: string; userHandle: string },
): Promise<void> {
  await saveWebauthnChallenge(value, purpose, CHALLENGE_TTL_MS / 1000);
  req.session.webauthnChallenge = { purpose, value, ...registration, expiresAt: Date.now() + CHALLENGE_TTL_MS };
}

/**
 * Removes the session's pending WebAuthn challenge and, if it is unexpired and for `purpose`,
 * atomically consumes it in the DB. The session copy is always cleared; the DB `DELETE` is what
 * guarantees single use, so even concurrent requests sharing one session can't both redeem it.
 * @param req - Express request whose session holds the challenge.
 * @param purpose - The ceremony being verified.
 * @returns The challenge (and bound Discord ID and user handle, for registration), or null if
 *   missing/expired/wrong purpose/already consumed.
 * @throws If the DB consume fails.
 */
export async function takeChallenge(
  req: Request,
  purpose: ChallengePurpose,
): Promise<{ value: string; discordId?: string; userHandle?: string } | null> {
  const stored = req.session.webauthnChallenge;
  delete req.session.webauthnChallenge;
  if (!stored || stored.purpose !== purpose || Date.now() > stored.expiresAt) return null;
  if (!(await consumeWebauthnChallenge(stored.value, purpose))) return null;
  return { value: stored.value, discordId: stored.discordId, userHandle: stored.userHandle };
}

/**
 * Consumes the session's registration challenge (see {@link takeChallenge}) and checks it was
 * issued to `discordId` and carries the user handle to store with the new passkey.
 * @param req - Express request whose session holds the challenge.
 * @param discordId - The signed-in user completing registration.
 * @returns The challenge value and user handle, or null if missing/invalid/for another user.
 * @throws If the DB consume fails.
 */
export async function takeRegistrationChallenge(
  req: Request,
  discordId: string,
): Promise<{ value: string; userHandle: string } | null> {
  const challenge = await takeChallenge(req, 'register');
  if (!challenge?.userHandle || challenge.discordId !== discordId) return null;
  return { value: challenge.value, userHandle: challenge.userHandle };
}

/**
 * Checks that a request body field looks like a WebAuthn credential response JSON (an object
 * with a string `id` and a `response` object). Full validation is left to `@simplewebauthn/server`.
 * @param value - The submitted `response` body field.
 * @returns True if the value has the basic credential-response shape.
 */
export function isCredentialResponse(value: unknown): value is { id: string; response: Record<string, unknown> } {
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
