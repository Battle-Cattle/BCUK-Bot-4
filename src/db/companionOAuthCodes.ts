import { createHash } from 'crypto';
import mysql from 'mysql2/promise';
import { getPool, withTransaction } from './pool';
import { issueTokenOnConnection } from './companionTokens';
import { generateSecretAndHash } from '../shared/crypto';

const CODE_TTL_SECONDS = 60;

/**
 * Creates a short-lived, single-use authorization code for the companion app's
 * loopback OAuth login flow. Only the SHA-256 hash is persisted. The expiry is
 * computed by the DB server (`DATE_ADD(NOW(), ...)`) rather than the app clock,
 * so it stays consistent with `consumeCodeOnConnection`'s `expires_at > NOW()` check even if
 * the app and DB clocks drift.
 *
 * @param discordId - Discord snowflake the code will resolve to once consumed.
 * @param codeChallenge - The app's PKCE S256 challenge, or null if it didn't send one. When set,
 *   the code only exchanges with the matching `code_verifier` (see {@link exchangeCodeForToken}).
 * @returns The plaintext code (only ever returned here — only the hash is stored).
 */
export async function createCode(discordId: string, codeChallenge: string | null = null): Promise<string> {
  const { secret: plain, hash } = generateSecretAndHash(24);
  await getPool().execute(
    `INSERT INTO companion_oauth_codes (code_hash, discord_id, expires_at, used_at, code_challenge)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), NULL, ?)`,
    [hash, discordId, CODE_TTL_SECONDS, codeChallenge],
  );
  return plain;
}

/**
 * The PKCE S256 challenge for a verifier: base64url (no padding) of its SHA-256 (RFC 7636 §4.2).
 * @param codeVerifier - The app's plaintext code verifier.
 * @returns The challenge to compare against the one stored with the code.
 */
export function pkceS256Challenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/**
 * Marks a companion OAuth code hash used (if it exists, hasn't expired, and hasn't
 * already been consumed) and returns the Discord ID it was issued for. The UPDATE's
 * `used_at IS NULL AND expires_at > NOW()` guard makes this safe against the same code
 * being redeemed twice concurrently. Shared by `createCode`'s expiry check and
 * `exchangeCodeForToken` (within a transaction), so both run identical mark-used-then-lookup SQL.
 *
 * A code issued with a PKCE challenge only matches when `verifierChallenge` equals it, and a code
 * issued without one only matches when no verifier was sent (RFC 9700 §4.8.2: a verifier with no
 * stored challenge means the login didn't come from this client, e.g. an injected code).
 * `code_challenge = NULL` is never true, so a missing verifier never satisfies a stored challenge.
 *
 * @param executor - Pool or transaction connection to run the query on.
 * @param hash - SHA-256 hash of the plaintext code.
 * @param verifierChallenge - S256 challenge of the presented code verifier, or null if none was sent.
 * @returns The Discord ID the code was issued for, or null if invalid/expired/already used, or its
 *   PKCE challenge doesn't match.
 */
async function consumeCodeOnConnection(
  executor: mysql.Pool | mysql.PoolConnection, hash: string, verifierChallenge: string | null,
): Promise<string | null> {
  const [result] = await executor.execute<mysql.ResultSetHeader>(
    `UPDATE companion_oauth_codes
     SET used_at = NOW()
     WHERE code_hash = ? AND used_at IS NULL AND expires_at > NOW()
       AND ((code_challenge IS NULL AND ? IS NULL) OR code_challenge = ?)`,
    [hash, verifierChallenge, verifierChallenge],
  );
  if (result.affectedRows === 0) return null;

  const [rows] = await executor.execute<mysql.RowDataPacket[]>(
    `SELECT discord_id FROM companion_oauth_codes WHERE code_hash = ?`,
    [hash],
  );
  return rows[0] ? String(rows[0].discord_id) : null;
}

/** A newly-issued companion app token, plaintext, plus who it belongs to. */
export interface CompanionTokenExchange {
  token: string;
  discordId: string;
}

/**
 * Atomically exchanges a companion OAuth code for a companion app token: marks
 * the code used and issues the token in a single DB transaction, so a failure
 * issuing the token rolls back the "used" mark instead of permanently burning
 * the code with nothing to show for it (which would force the user to redo the
 * entire Discord OAuth login).
 *
 * @param code - Plaintext code presented by the companion app.
 * @param codeVerifier - The app's PKCE code verifier, or null if it didn't send one. Required when
 *   the code was issued with a challenge.
 * @returns The plaintext companion app token and its owning Discord ID (the caller needs the
 *   latter to disconnect any SSE connection still open under a token this issue just replaced),
 *   or null if the code is invalid/expired/already used, or fails its PKCE check.
 */
export async function exchangeCodeForToken(code: string, codeVerifier: string | null = null): Promise<CompanionTokenExchange | null> {
  const hash = createHash('sha256').update(code).digest('hex');
  const verifierChallenge = codeVerifier === null ? null : pkceS256Challenge(codeVerifier);
  class CodeNotFoundError extends Error {}
  try {
    return await withTransaction(async (conn) => {
      const discordId = await consumeCodeOnConnection(conn, hash, verifierChallenge);
      // Throwing (rather than returning null) rolls back the "used" mark applied by
      // consumeCodeOnConnection above, so an invalid/expired/already-used code — or the
      // edge case where the row vanishes between the UPDATE and the follow-up SELECT —
      // doesn't permanently burn the code with no token to show for it.
      if (!discordId) throw new CodeNotFoundError();
      const token = await issueTokenOnConnection(conn, discordId);
      return { token, discordId };
    });
  } catch (err) {
    if (err instanceof CodeNotFoundError) return null;
    throw err;
  }
}
