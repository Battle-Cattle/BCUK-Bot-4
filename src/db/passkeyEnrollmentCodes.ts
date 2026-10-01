import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { isMysqlDuplicateEntryError } from './commandStringUtils';

/** Outcome of checking a passkey enrollment code. */
export type EnrollmentCodeResult = 'ok' | 'invalid' | 'expired';

/**
 * Stores a freshly-generated passkey enrollment code for a user (one outstanding code per user),
 * unless one was sent to them within the resend cooldown. Expired codes are pruned first, and a
 * user's code older than the cooldown is replaced. The final plain `INSERT` against the
 * `discord_id` primary key is what makes the cooldown hold under concurrent requests: only one of
 * them can insert.
 * @param discordId - The user the code is for.
 * @param codeHash - SHA-256 hex digest of the code (the code itself is never stored).
 * @param ttlSeconds - How long the code stays usable.
 * @param resendCooldownSeconds - Minimum time between two codes for the same user.
 * @returns True if the code was stored; false if a code was sent too recently.
 */
export async function savePasskeyEnrollmentCode(
  discordId: string,
  codeHash: string,
  ttlSeconds: number,
  resendCooldownSeconds: number,
): Promise<boolean> {
  const pool = getPool();
  await pool.execute('DELETE FROM passkey_enrollment_codes WHERE expires_at <= NOW()');
  await pool.execute(
    'DELETE FROM passkey_enrollment_codes WHERE discord_id = ? AND sent_at <= DATE_SUB(NOW(), INTERVAL ? SECOND)',
    [discordId, resendCooldownSeconds],
  );
  try {
    await pool.execute(
      `INSERT INTO passkey_enrollment_codes (discord_id, code_hash, attempts, sent_at, expires_at)
       VALUES (?, ?, 0, NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND))`,
      [discordId, codeHash, ttlSeconds],
    );
    return true;
  } catch (err) {
    if (isMysqlDuplicateEntryError(err)) return false;
    throw err;
  }
}

/**
 * Checks and consumes a user's passkey enrollment code. Each call first spends one attempt with a
 * conditional `UPDATE` (which only matches an unexpired code with attempts left), so concurrent
 * guesses can never exceed `maxAttempts` in total; only then is the code compared, by a
 * conditional `DELETE` that consumes it on a match.
 * @param discordId - The user entering the code.
 * @param codeHash - SHA-256 hex digest of the code they entered.
 * @param maxAttempts - How many guesses a single code allows.
 * @returns `'ok'` if the code matched (and is now consumed), `'invalid'` if it didn't, or
 *   `'expired'` if there's no usable code (never sent, expired, or out of attempts).
 */
export async function consumePasskeyEnrollmentCode(
  discordId: string,
  codeHash: string,
  maxAttempts: number,
): Promise<EnrollmentCodeResult> {
  const pool = getPool();
  const [spent] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE passkey_enrollment_codes SET attempts = attempts + 1
     WHERE discord_id = ? AND expires_at > NOW() AND attempts < ?`,
    [discordId, maxAttempts],
  );
  if (spent.affectedRows !== 1) return 'expired';
  const [consumed] = await pool.execute<mysql.ResultSetHeader>(
    'DELETE FROM passkey_enrollment_codes WHERE discord_id = ? AND code_hash = ?',
    [discordId, codeHash],
  );
  return consumed.affectedRows === 1 ? 'ok' : 'invalid';
}

/**
 * Removes one specific enrollment code, e.g. when the DM carrying it couldn't be sent, so the user
 * can request a new one straight away instead of waiting out the resend cooldown. Matching on the
 * code's hash as well as the user means a late cleanup for an older code can never delete a newer
 * code issued to the same user in the meantime.
 * @param discordId - The user the code was issued to.
 * @param codeHash - SHA-256 hex digest of the code to remove.
 */
export async function deletePasskeyEnrollmentCode(discordId: string, codeHash: string): Promise<void> {
  await getPool().execute(
    'DELETE FROM passkey_enrollment_codes WHERE discord_id = ? AND code_hash = ?',
    [discordId, codeHash],
  );
}
