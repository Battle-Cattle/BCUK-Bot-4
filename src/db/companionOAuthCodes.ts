import { randomBytes, createHash } from 'crypto';
import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { issueTokenOnConnection } from './companionTokens';

const CODE_TTL_SECONDS = 60;

/**
 * Creates a short-lived, single-use authorization code for the companion app's
 * loopback OAuth login flow. Only the SHA-256 hash is persisted. The expiry is
 * computed by the DB server (`DATE_ADD(NOW(), ...)`) rather than the app clock,
 * so it stays consistent with `consumeCode`'s `expires_at > NOW()` check even if
 * the app and DB clocks drift.
 *
 * @param discordId - Discord snowflake the code will resolve to once consumed.
 * @returns The plaintext code (only ever returned here — only the hash is stored).
 */
export async function createCode(discordId: string): Promise<string> {
  const plain = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(plain).digest('hex');
  await getPool().execute(
    `INSERT INTO companion_oauth_codes (code_hash, discord_id, expires_at, used_at)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), NULL)`,
    [hash, discordId, CODE_TTL_SECONDS],
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

/**
 * Atomically exchanges a companion OAuth code for a companion app token: marks
 * the code used and issues the token in a single DB transaction, so a failure
 * issuing the token rolls back the "used" mark instead of permanently burning
 * the code with nothing to show for it (which would force the user to redo the
 * entire Discord OAuth login).
 *
 * @param code - Plaintext code presented by the companion app.
 * @returns The plaintext companion app token, or null if the code is invalid/expired/already used.
 */
export async function exchangeCodeForToken(code: string): Promise<string | null> {
  const hash = createHash('sha256').update(code).digest('hex');
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute<mysql.ResultSetHeader>(
      `UPDATE companion_oauth_codes
       SET used_at = NOW()
       WHERE code_hash = ? AND used_at IS NULL AND expires_at > NOW()`,
      [hash],
    );
    if (result.affectedRows === 0) {
      await conn.rollback();
      return null;
    }

    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT discord_id FROM companion_oauth_codes WHERE code_hash = ?`,
      [hash],
    );
    if (rows.length === 0) {
      await conn.rollback();
      return null;
    }

    const token = await issueTokenOnConnection(conn, String(rows[0].discord_id));
    await conn.commit();
    return token;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}
