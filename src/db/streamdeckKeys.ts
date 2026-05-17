import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { AccessLevel } from './users';

export interface StreamdeckKeyRow {
  discord_id: string;
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
    status: r.status as StreamdeckKeyRow['status'],
    requested_at: r.requested_at,
    approved_at: r.approved_at ?? null,
    approved_by: r.approved_by ?? null,
    user_name: r.user_name ?? null,
    approver_name: r.approver_name ?? null,
  };
}

export async function requestApiKey(
  discordId: string,
  accessLevel: number,
): Promise<{ plain: string; status: 'pending' | 'approved' }> {
  const plain = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(plain).digest('hex');
  const status = accessLevel >= AccessLevel.MANAGER ? 'approved' : 'pending';
  const now = new Date();
  const approvedAt = status === 'approved' ? now : null;
  const approvedBy = status === 'approved' ? discordId : null;

  await getPool().execute(
    `INSERT INTO streamdeck_api_keys
       (discord_id, key_hash, status, requested_at, approved_at, approved_by)
     VALUES (?, ?, ?, ?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       key_hash     = new_row.key_hash,
       status       = new_row.status,
       requested_at = new_row.requested_at,
       approved_at  = new_row.approved_at,
       approved_by  = new_row.approved_by`,
    [discordId, hash, status, now, approvedAt, approvedBy],
  );

  return { plain, status };
}

export async function findApprovedKeyByHash(hash: string): Promise<StreamdeckKeyRow | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT discord_id, key_hash, status, requested_at, approved_at, approved_by
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

export async function getApiKeyStatus(discordId: string): Promise<StreamdeckKeyRow | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT discord_id, status, requested_at, approved_at, approved_by
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

export async function getPendingRequests(): Promise<StreamdeckKeyRow[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT k.discord_id, k.status, k.requested_at, k.approved_at, k.approved_by,
            u.discord_name AS user_name, NULL AS approver_name
     FROM streamdeck_api_keys k
     LEFT JOIN \`user\` u ON u.discord_id = k.discord_id
     WHERE k.status = 'pending'
     ORDER BY k.requested_at ASC`,
  );
  return rows.map(mapRow);
}

export async function getAllApiKeys(): Promise<StreamdeckKeyRow[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT k.discord_id, k.status, k.requested_at, k.approved_at, k.approved_by,
            u.discord_name AS user_name, a.discord_name AS approver_name
     FROM streamdeck_api_keys k
     LEFT JOIN \`user\` u ON u.discord_id = k.discord_id
     LEFT JOIN \`user\` a ON a.discord_id = k.approved_by
     ORDER BY k.status ASC, k.requested_at ASC`,
  );
  return rows.map(mapRow);
}
