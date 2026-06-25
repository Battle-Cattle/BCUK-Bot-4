import { randomBytes, createHash } from 'crypto';
import mysql from 'mysql2/promise';
import { getPool } from './pool';

const CODE_TTL_MS = 60_000;

/**
 * Creates a short-lived, single-use authorization code for the companion app's
 * loopback OAuth login flow. Only the SHA-256 hash is persisted.
 *
 * @param discordId - Discord snowflake the code will resolve to once consumed.
 * @returns The plaintext code (only ever returned here — only the hash is stored).
 */
export async function createCode(discordId: string): Promise<string> {
  const plain = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(plain).digest('hex');
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await getPool().execute(
    `INSERT INTO companion_oauth_codes (code_hash, discord_id, expires_at, used_at)
     VALUES (?, ?, ?, NULL)`,
    [hash, discordId, expiresAt],
  );
  return plain;
}

/**
 * Atomically consumes a companion OAuth code: marks it used and returns the
 * Discord ID it was issued for, but only if it exists, hasn't expired, and
 * hasn't already been consumed. The UPDATE's `used_at IS NULL AND expires_at >
 * NOW()` guard makes this safe against a code being redeemed twice concurrently.
 *
 * @param code - Plaintext code presented by the companion app.
 * @returns The Discord ID the code was issued for, or null if invalid/expired/already used.
 */
export async function consumeCode(code: string): Promise<string | null> {
  const hash = createHash('sha256').update(code).digest('hex');
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE companion_oauth_codes
     SET used_at = NOW()
     WHERE code_hash = ? AND used_at IS NULL AND expires_at > NOW()`,
    [hash],
  );
  if (result.affectedRows === 0) return null;

  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT discord_id FROM companion_oauth_codes WHERE code_hash = ?`,
    [hash],
  );
  return rows.length === 0 ? null : String(rows[0].discord_id);
}
