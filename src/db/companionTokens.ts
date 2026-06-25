import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import mysql from 'mysql2/promise';
import { getPool } from './pool';

export interface CompanionTokenStatus {
  hasToken: boolean;
  createdAt: Date;
}

/**
 * Issues (or replaces) the companion app token for a Discord user. Generates a
 * new plaintext token, stores only its SHA-256 hash, and clears any prior
 * revocation — a user has at most one active token at a time.
 *
 * @param discordId - Discord snowflake to issue the token for.
 * @returns The plaintext token (only ever returned here — only the hash is stored).
 */
export async function issueToken(discordId: string): Promise<string> {
  const plain = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(plain).digest('hex');
  const now = new Date();
  await getPool().execute(
    `INSERT INTO companion_app_tokens (discord_id, key_hash, created_at, revoked_at)
     VALUES (?, ?, ?, NULL) AS new_row
     ON DUPLICATE KEY UPDATE
       key_hash   = new_row.key_hash,
       created_at = new_row.created_at,
       revoked_at = NULL`,
    [discordId, hash, now],
  );
  return plain;
}

/**
 * Looks up the Discord ID owning an active (non-revoked) companion token by its
 * SHA-256 hash. Re-verifies with a timing-safe comparison after the lookup,
 * since the table's case-insensitive collation could otherwise match hashes
 * that differ only by case.
 *
 * @param hash - SHA-256 hash of the submitted plaintext token.
 * @returns The owning Discord ID, or null if no active token matches.
 */
export async function findDiscordIdByTokenHash(hash: string): Promise<string | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT discord_id, key_hash FROM companion_app_tokens WHERE key_hash = ? AND revoked_at IS NULL`,
    [hash],
  );
  if (rows.length === 0) return null;
  const stored = Buffer.from(String(rows[0].key_hash), 'hex');
  const incoming = Buffer.from(hash, 'hex');
  if (stored.length !== incoming.length || !timingSafeEqual(stored, incoming)) return null;
  return String(rows[0].discord_id);
}

/**
 * Gets the current companion token status for a Discord user.
 *
 * @param discordId - Discord snowflake to look up.
 * @returns Token presence/creation date, or null if the user never issued one.
 */
export async function getTokenStatus(discordId: string): Promise<CompanionTokenStatus | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT created_at, revoked_at FROM companion_app_tokens WHERE discord_id = ?`,
    [discordId],
  );
  if (rows.length === 0) return null;
  return { hasToken: rows[0].revoked_at === null, createdAt: rows[0].created_at };
}

/**
 * Revokes a Discord user's companion app token, regardless of its current status.
 *
 * @param discordId - Discord snowflake whose token should be revoked.
 * @returns A promise that resolves once the update completes.
 */
export async function revokeToken(discordId: string): Promise<void> {
  await getPool().execute(
    `UPDATE companion_app_tokens SET revoked_at = NOW() WHERE discord_id = ?`,
    [discordId],
  );
}
