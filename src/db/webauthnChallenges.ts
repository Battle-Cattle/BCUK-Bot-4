import mysql from 'mysql2/promise';
import { getPool } from './pool';

/** Which WebAuthn ceremony a challenge was issued for. */
export type WebauthnChallengePurpose = 'register' | 'login';

/**
 * Records a freshly-issued WebAuthn challenge so it can later be consumed exactly once, and
 * prunes expired challenges while it's there (unused options requests otherwise leave rows
 * behind). The expiry is computed DB-side (`DATE_ADD(NOW(), ...)`) so it stays consistent with
 * {@link consumeWebauthnChallenge}'s `expires_at > NOW()` check regardless of app/DB clock drift.
 * @param challenge - The base64url challenge from the generated options.
 * @param purpose - The ceremony it was issued for.
 * @param ttlSeconds - How long the challenge stays redeemable.
 */
export async function saveWebauthnChallenge(
  challenge: string,
  purpose: WebauthnChallengePurpose,
  ttlSeconds: number,
): Promise<void> {
  const pool = getPool();
  await pool.execute('DELETE FROM webauthn_challenges WHERE expires_at <= NOW()');
  await pool.execute(
    `INSERT INTO webauthn_challenges (challenge, purpose, expires_at)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [challenge, purpose, ttlSeconds],
  );
}

/**
 * Atomically consumes a WebAuthn challenge: a single conditional `DELETE` that only matches an
 * unexpired challenge for `purpose`, so when two requests race to verify with the same challenge
 * exactly one sees `affectedRows = 1` and the other is rejected.
 * @param challenge - The base64url challenge being verified.
 * @param purpose - The ceremony being verified.
 * @returns True if this call consumed the challenge, false if it was unknown, expired, issued
 *   for the other purpose, or already consumed.
 */
export async function consumeWebauthnChallenge(
  challenge: string,
  purpose: WebauthnChallengePurpose,
): Promise<boolean> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    'DELETE FROM webauthn_challenges WHERE challenge = ? AND purpose = ? AND expires_at > NOW()',
    [challenge, purpose],
  );
  return result.affectedRows === 1;
}
