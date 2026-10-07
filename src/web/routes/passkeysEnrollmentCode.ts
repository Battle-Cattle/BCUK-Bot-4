import { createHash, randomInt } from 'crypto';
import { Router, type Request, type Response } from 'express';
import {
  savePasskeyEnrollmentCode,
  consumePasskeyEnrollmentCode,
  deletePasskeyEnrollmentCode,
  listPasskeyDescriptorsForUser,
} from '../../db';
import { sendDiscordDirectMessage } from '../../discord/discordApi';
import { createLogger } from '../../shared/logger';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { hasRecentDiscordAuth, MAX_PASSKEYS_PER_USER } from './passkeysShared';

// Adding a passkey needs a one-time code DMed to the user by the bot: proof that whoever is adding
// it controls the Discord account, not just a (possibly hijacked) web session. The DM also warns
// the account owner if someone else tries.

const log = createLogger('Web');
const router = Router();

const CODE_TTL_SECONDS = 5 * 60;
const CODE_RESEND_COOLDOWN_SECONDS = 60;
const CODE_MAX_ATTEMPTS = 5;
const CODE_PATTERN = /^\d{6}$/;

/**
 * Hashes an enrollment code for storage/comparison, so the DB never holds the code itself.
 * @param code - The 6-digit code.
 * @returns Its SHA-256 hex digest.
 */
export function hashEnrollmentCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Generates a uniformly random 6-digit enrollment code (leading zeros kept).
 * @returns The code as a 6-character string.
 */
export function generateEnrollmentCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * POST /auth/passkey/register/code — DMs the signed-in user a one-time code they must enter to
 * add a passkey. Requires a recent Discord login, and the user must be under the passkey limit.
 * @param req - Express request; requires an authenticated session and CSRF token.
 * @param res - Express response; `{ ok: true }` once the DM is sent. Otherwise
 *   403 `passkey_reauth_required`, 409 `passkey_limit`, 429 `passkey_code_throttled` (a code was
 *   sent within the last minute and is still usable), 502 `passkey_dm_failed` (the bot couldn't
 *   DM the user), or 500 `passkey_register_failed`.
 */
router.post('/register/code', requireAuth, csrfProtection, async (req, res) => {
  if (!hasRecentDiscordAuth(req)) {
    res.status(403).json({ ok: false, error: 'passkey_reauth_required' });
    return;
  }
  const { discordId } = getSessionUser(req);
  try {
    if ((await listPasskeyDescriptorsForUser(discordId)).length >= MAX_PASSKEYS_PER_USER) {
      res.status(409).json({ ok: false, error: 'passkey_limit' });
      return;
    }
    const code = generateEnrollmentCode();
    const codeHash = hashEnrollmentCode(code);
    if (!(await savePasskeyEnrollmentCode(discordId, codeHash, CODE_TTL_SECONDS, CODE_RESEND_COOLDOWN_SECONDS))) {
      res.status(429).json({ ok: false, error: 'passkey_code_throttled' });
      return;
    }
    const sent = await sendDiscordDirectMessage(
      discordId,
      `Your BCUK Bot passkey confirmation code is **${code}**. It expires in 5 minutes.\n\n` +
        "If you didn't just try to add a passkey in the BCUK Bot web panel, don't enter or share this code: " +
        'someone else may have access to your panel session. Sign out of the panel and sign back in.',
    );
    if (!sent) {
      // Drop the undeliverable code (only this one, never a newer code) so the user can retry
      // right away once they allow DMs.
      await deletePasskeyEnrollmentCode(discordId, codeHash);
      res.status(502).json({ ok: false, error: 'passkey_dm_failed' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    log.error('Passkey enrollment code error:', err);
    res.status(500).json({ ok: false, error: 'passkey_register_failed' });
  }
});

/**
 * Checks the enrollment code in a registration request, consuming it on a match, and replies
 * with the failure itself otherwise. Each check spends one of the code's limited attempts.
 * @param req - Express request; JSON body `{ code }`.
 * @param res - Express response; sent 400 `passkey_code_invalid` (wrong or malformed code) or
 *   400 `passkey_code_expired` (none sent, expired, or out of attempts) on failure.
 * @param discordId - The signed-in user.
 * @returns True if the code was valid and the caller should continue.
 */
export async function checkEnrollmentCode(req: Request, res: Response, discordId: string): Promise<boolean> {
  const code = (req.body as { code?: unknown } | undefined)?.code;
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
    res.status(400).json({ ok: false, error: 'passkey_code_invalid' });
    return false;
  }
  const result = await consumePasskeyEnrollmentCode(discordId, hashEnrollmentCode(code), CODE_MAX_ATTEMPTS);
  if (result !== 'ok') {
    res.status(400).json({ ok: false, error: result === 'invalid' ? 'passkey_code_invalid' : 'passkey_code_expired' });
    return false;
  }
  return true;
}

export default router;
