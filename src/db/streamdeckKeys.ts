import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { AccessLevel } from './users';

export interface StreamdeckKeyRow {
  discord_id: string;
  /** The guild this key acts on. */
  guild_id: string | null;
  status: 'pending' | 'approved' | 'revoked' | 'denied';
  requested_at: Date;
  approved_at: Date | null;
  approved_by: string | null;
  user_name: string | null;
  approver_name: string | null;
}

function mapRow(r: mysql.RowDataPacket): StreamdeckKeyRow {
  return {
    discord_id: String(r.discord_id),
    guild_id: r.guild_id === null ? null : String(r.guild_id),
    status: r.status as StreamdeckKeyRow['status'],
    requested_at: r.requested_at,
    approved_at: r.approved_at ?? null,
    approved_by: r.approved_by ?? null,
    user_name: r.user_name ?? null,
    approver_name: r.approver_name ?? null,
  };
}

/**
 * Requests (or re-requests) a Streamdeck API key for a user, scoped to one guild.
 * Manager+ access levels are auto-approved; everyone else is queued as pending.
 * Throws if a previous request for this user was denied.
 *
 * @param discordId Requesting user's Discord snowflake.
 * @param accessLevel The user's effective access level in `guildId`, used to decide auto-approval.
 * @param guildId The guild the key will act on.
 * @returns The plaintext key (only ever returned here — only the hash is stored) and its status.
 */
export async function requestApiKey(
  discordId: string,
  accessLevel: number,
  guildId: string,
): Promise<{ plain: string; status: 'pending' | 'approved' }> {
  const existing = await getApiKeyStatus(discordId);
  if (existing?.status === 'denied') {
    throw new Error('API key request rejected: previous request was denied');
  }

  const plain = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(plain).digest('hex');
  const status = accessLevel >= AccessLevel.MANAGER ? 'approved' : 'pending';
  const now = new Date();
  const approvedAt = status === 'approved' ? now : null;
  const approvedBy = status === 'approved' ? discordId : null;

  await getPool().execute(
    `INSERT INTO streamdeck_api_keys
       (discord_id, key_hash, guild_id, status, requested_at, approved_at, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       key_hash     = IF(streamdeck_api_keys.status = 'denied', streamdeck_api_keys.key_hash,     new_row.key_hash),
       guild_id     = IF(streamdeck_api_keys.status = 'denied', streamdeck_api_keys.guild_id,     new_row.guild_id),
       status       = IF(streamdeck_api_keys.status = 'denied', streamdeck_api_keys.status,       new_row.status),
       requested_at = IF(streamdeck_api_keys.status = 'denied', streamdeck_api_keys.requested_at, new_row.requested_at),
       approved_at  = IF(streamdeck_api_keys.status = 'denied', streamdeck_api_keys.approved_at,  new_row.approved_at),
       approved_by  = IF(streamdeck_api_keys.status = 'denied', streamdeck_api_keys.approved_by,  new_row.approved_by)`,
    [discordId, hash, guildId, status, now, approvedAt, approvedBy],
  );

  const after = await getApiKeyStatus(discordId);
  if (after?.status === 'denied') {
    throw new Error('API key request rejected: previous request was denied');
  }

  return { plain, status };
}

/**
 * Finds an approved Streamdeck API key by its SHA-256 hash.
 *
 * @param hash SHA-256 hash of the submitted plaintext key.
 * @returns The approved key row, including its guild binding, or null when not found.
 */
export async function findApprovedKeyByHash(hash: string): Promise<StreamdeckKeyRow | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT discord_id, key_hash, guild_id, status, requested_at, approved_at, approved_by
     FROM streamdeck_api_keys
     WHERE key_hash = ? AND status = 'approved'`,
    [hash],
  );
  if (rows.length === 0) return null;
  const stored = Buffer.from(String(rows[0].key_hash), 'hex');
  const incoming = Buffer.from(hash, 'hex');
  if (stored.length !== incoming.length || !timingSafeEqual(stored, incoming)) return null;
  return mapRow(rows[0]);
}

/**
 * Gets the current Streamdeck API key status for a Discord user.
 *
 * @param discordId Requesting user's Discord snowflake.
 * @returns The key row, including its guild binding, or null when no request exists.
 */
export async function getApiKeyStatus(discordId: string): Promise<StreamdeckKeyRow | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT discord_id, guild_id, status, requested_at, approved_at, approved_by
     FROM streamdeck_api_keys
     WHERE discord_id = ?`,
    [discordId],
  );
  return rows.length === 0 ? null : mapRow(rows[0]);
}

export async function approveApiKey(discordId: string, approvedBy: string): Promise<void> {
  await getPool().execute(
    `UPDATE streamdeck_api_keys
     SET status = 'approved', approved_at = NOW(), approved_by = ?
     WHERE discord_id = ? AND status = 'pending'`,
    [approvedBy, discordId],
  );
}

export async function denyApiKey(discordId: string): Promise<void> {
  await getPool().execute(
    `UPDATE streamdeck_api_keys SET status = 'denied' WHERE discord_id = ? AND status = 'pending'`,
    [discordId],
  );
}

export async function revokeApiKey(discordId: string): Promise<void> {
  await getPool().execute(
    `UPDATE streamdeck_api_keys SET status = 'revoked' WHERE discord_id = ?`,
    [discordId],
  );
}

/**
 * Lists pending Streamdeck API key requests.
 *
 * @returns Pending key rows, including requester names and guild bindings, oldest first.
 */
export async function getPendingRequests(): Promise<StreamdeckKeyRow[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT k.discord_id, k.guild_id, k.status, k.requested_at, k.approved_at, k.approved_by,
            u.discord_name AS user_name, NULL AS approver_name
     FROM streamdeck_api_keys k
     LEFT JOIN \`user\` u ON u.discord_id = k.discord_id
     WHERE k.status = 'pending'
     ORDER BY k.requested_at ASC`,
  );
  return rows.map(mapRow);
}

/**
 * Lists all Streamdeck API keys.
 *
 * @returns Key rows, including requester/approver names and guild bindings.
 */
export async function getAllApiKeys(): Promise<StreamdeckKeyRow[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT k.discord_id, k.guild_id, k.status, k.requested_at, k.approved_at, k.approved_by,
            u.discord_name AS user_name, a.discord_name AS approver_name
     FROM streamdeck_api_keys k
     LEFT JOIN \`user\` u ON u.discord_id = k.discord_id
     LEFT JOIN \`user\` a ON a.discord_id = k.approved_by
     ORDER BY k.status ASC, k.requested_at ASC`,
  );
  return rows.map(mapRow);
}
