import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import mysql from 'mysql2/promise';
import { getPool, withTransaction } from './pool';
import { AccessLevel } from './users';

/** Per-guild approval state for a Streamdeck API key. */
export interface StreamdeckKeyGuildStatusRow {
  discord_id: string;
  guild_id: string;
  status: 'pending' | 'approved' | 'revoked' | 'denied';
  requested_at: Date;
  approved_at: Date | null;
  approved_by: string | null;
  user_name: string | null;
  approver_name: string | null;
}

/**
 * Maps a raw `streamdeck_key_guild_status` row (joined with user/approver names)
 * to a {@link StreamdeckKeyGuildStatusRow}.
 * @param r Raw row from a `streamdeck_key_guild_status` query.
 * @returns The mapped guild-status row.
 */
function mapStatusRow(r: mysql.RowDataPacket): StreamdeckKeyGuildStatusRow {
  return {
    discord_id: String(r.discord_id),
    guild_id: String(r.guild_id),
    status: r.status as StreamdeckKeyGuildStatusRow['status'],
    requested_at: r.requested_at,
    approved_at: r.approved_at ?? null,
    approved_by: r.approved_by ?? null,
    user_name: r.user_name ?? null,
    approver_name: r.approver_name ?? null,
  };
}

/** Computes the auto-approval status for a fresh guild-access request. */
function initialStatus(accessLevel: number): 'pending' | 'approved' {
  return accessLevel >= AccessLevel.MANAGER ? 'approved' : 'pending';
}

/**
 * Returns true if the Discord user already has a Streamdeck API key identity
 * (a `streamdeck_api_keys` row), regardless of its per-guild approval state.
 *
 * @param discordId User's Discord snowflake.
 */
export async function hasApiKey(discordId: string): Promise<boolean> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT 1 FROM streamdeck_api_keys WHERE discord_id = ?',
    [discordId],
  );
  return rows.length > 0;
}

/**
 * Creates a brand-new Streamdeck API key for a user who doesn't have one yet,
 * together with their first guild's approval-status row. Only ever called for
 * a `discordId` with no existing key — use {@link requestGuildAccessForExistingKey}
 * to extend an existing key to another guild.
 *
 * @param discordId Requesting user's Discord snowflake.
 * @param accessLevel The user's effective access level in `guildId`, used to decide auto-approval.
 * @param guildId The first guild this key will act on.
 * @returns The plaintext key (only ever returned here — only the hash is stored) and its status.
 */
export async function createApiKeyAndRequestGuildAccess(
  discordId: string,
  accessLevel: number,
  guildId: string,
): Promise<{ plain: string; status: 'pending' | 'approved' }> {
  const plain = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(plain).digest('hex');
  const status = initialStatus(accessLevel);
  const now = new Date();

  // Both inserts must commit together — a partial failure would strand a key
  // identity with no guild-status row, and the plaintext (only ever returned
  // here) would be unrecoverable.
  await withTransaction(async (conn) => {
    await conn.execute(
      'INSERT INTO streamdeck_api_keys (discord_id, key_hash, created_at) VALUES (?, ?, ?)',
      [discordId, hash, now],
    );
    await conn.execute(
      `INSERT INTO streamdeck_key_guild_status
         (discord_id, guild_id, status, requested_at, approved_at, approved_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [discordId, guildId, status, now, status === 'approved' ? now : null, status === 'approved' ? discordId : null],
    );
  });

  return { plain, status };
}

/**
 * Requests (or re-requests) access to another guild for a Discord user who
 * already has a Streamdeck API key. Reuses the existing key — no new
 * plaintext is generated or returned, since only the key's hash is stored.
 * Manager+ access levels are auto-approved; everyone else is queued as
 * pending. Throws if a previous request for this (user, guild) pair was denied.
 *
 * @param discordId Requesting user's Discord snowflake.
 * @param accessLevel The user's effective access level in `guildId`, used to decide auto-approval.
 * @param guildId The guild to request access for.
 * @returns The resulting status for this guild.
 */
export async function requestGuildAccessForExistingKey(
  discordId: string,
  accessLevel: number,
  guildId: string,
): Promise<{ status: 'pending' | 'approved' }> {
  const status = initialStatus(accessLevel);
  const now = new Date();
  const approvedAt = status === 'approved' ? now : null;
  const approvedBy = status === 'approved' ? discordId : null;

  await getPool().execute(
    `INSERT INTO streamdeck_key_guild_status
       (discord_id, guild_id, status, requested_at, approved_at, approved_by)
     VALUES (?, ?, ?, ?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       status       = IF(streamdeck_key_guild_status.status = 'denied', streamdeck_key_guild_status.status,       new_row.status),
       requested_at = IF(streamdeck_key_guild_status.status = 'denied', streamdeck_key_guild_status.requested_at, new_row.requested_at),
       approved_at  = IF(streamdeck_key_guild_status.status = 'denied', streamdeck_key_guild_status.approved_at,  new_row.approved_at),
       approved_by  = IF(streamdeck_key_guild_status.status = 'denied', streamdeck_key_guild_status.approved_by,  new_row.approved_by)`,
    [discordId, guildId, status, now, approvedAt, approvedBy],
  );

  const after = await getGuildStatusForKey(discordId, guildId);
  if (after?.status === 'denied') {
    throw new Error('API key request rejected: previous request was denied');
  }
  return { status };
}

/**
 * Rotates a user's Streamdeck API key secret (e.g. after it's lost), keeping
 * every guild's existing approval state untouched — only the key's identity
 * (hash) changes, so the old key stops working everywhere immediately.
 *
 * @param discordId User's Discord snowflake; must already have a key.
 * @returns The new plaintext key.
 */
export async function rotateApiKey(discordId: string): Promise<{ plain: string }> {
  const plain = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(plain).digest('hex');
  await getPool().execute(
    'UPDATE streamdeck_api_keys SET key_hash = ?, created_at = ? WHERE discord_id = ?',
    [hash, new Date(), discordId],
  );
  return { plain };
}

/**
 * Finds the Discord ID owning a Streamdeck API key by its SHA-256 hash. This
 * is purely an identity lookup — it does not authorize any guild by itself;
 * every caller must separately check {@link isKeyApprovedForGuild} for the
 * specific guild a request targets, so there is exactly one source of truth
 * for per-guild approval instead of two checks that could drift apart.
 *
 * @param hash SHA-256 hash of the submitted plaintext key.
 * @returns The owning Discord ID, or null when no key matches this hash.
 */
export async function findKeyByHash(hash: string): Promise<{ discordId: string } | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT discord_id, key_hash FROM streamdeck_api_keys WHERE key_hash = ?',
    [hash],
  );
  if (rows.length === 0) return null;
  const stored = Buffer.from(String(rows[0].key_hash), 'hex');
  const incoming = Buffer.from(hash, 'hex');
  if (stored.length !== incoming.length || !timingSafeEqual(stored, incoming)) return null;
  return { discordId: String(rows[0].discord_id) };
}

/**
 * Lists every guild ID a Discord user's Streamdeck key is currently approved
 * for. Used to browse voice channels across all of a key's approved guilds
 * without needing to guess which single guild the key targets.
 *
 * @param discordId Key owner's Discord snowflake.
 */
export async function getApprovedGuildIdsForKey(discordId: string): Promise<string[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT guild_id FROM streamdeck_key_guild_status WHERE discord_id = ? AND status = 'approved'`,
    [discordId],
  );
  return rows.map((r) => String(r.guild_id));
}

/**
 * Returns true if the given Discord user's Streamdeck key is approved for the
 * given guild specifically.
 *
 * @param discordId Key owner's Discord snowflake.
 * @param guildId Guild to check approval for.
 */
export async function isKeyApprovedForGuild(discordId: string, guildId: string): Promise<boolean> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT 1 FROM streamdeck_key_guild_status WHERE discord_id = ? AND guild_id = ? AND status = 'approved'`,
    [discordId, guildId],
  );
  return rows.length > 0;
}

/**
 * Gets a Discord user's Streamdeck key request/approval status for one guild.
 *
 * @param discordId Requesting user's Discord snowflake.
 * @param guildId Guild to read the status for.
 * @returns The guild-status row, or null when no request exists for this (user, guild) pair.
 */
export async function getGuildStatusForKey(discordId: string, guildId: string): Promise<StreamdeckKeyGuildStatusRow | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT discord_id, guild_id, status, requested_at, approved_at, approved_by
     FROM streamdeck_key_guild_status
     WHERE discord_id = ? AND guild_id = ?`,
    [discordId, guildId],
  );
  return rows.length === 0 ? null : mapStatusRow(rows[0]);
}

/**
 * Approves a pending Streamdeck API key request for one guild.
 *
 * @param discordId Requester's Discord snowflake.
 * @param approvedBy Approver's Discord snowflake.
 * @param guildId Guild the approving admin is acting in; the request must be for this guild.
 * @returns Resolves once the update completes; a no-op if the request isn't pending for `guildId`.
 */
export async function approveApiKey(discordId: string, approvedBy: string, guildId: string): Promise<void> {
  await getPool().execute(
    `UPDATE streamdeck_key_guild_status
     SET status = 'approved', approved_at = NOW(), approved_by = ?
     WHERE discord_id = ? AND status = 'pending' AND guild_id = ?`,
    [approvedBy, discordId, guildId],
  );
}

/**
 * Denies a pending Streamdeck API key request for one guild, permanently
 * blocking future requests from this user for that guild.
 *
 * @param discordId Requester's Discord snowflake.
 * @param guildId Guild the denying admin is acting in; the request must be for this guild.
 * @returns Resolves once the update completes; a no-op if the request isn't pending for `guildId`.
 */
export async function denyApiKey(discordId: string, guildId: string): Promise<void> {
  await getPool().execute(
    `UPDATE streamdeck_key_guild_status SET status = 'denied' WHERE discord_id = ? AND status = 'pending' AND guild_id = ?`,
    [discordId, guildId],
  );
}

/**
 * Revokes a Discord user's Streamdeck access for one guild. Used for both
 * self-service and admin-initiated revokes — revoking always affects only the
 * named guild, leaving the same key's approval state in every other guild
 * untouched. A `denied` row is left as-is: denial is meant to permanently
 * block re-requesting, and revoking it would let a denied user recreate
 * access simply by calling this instead of getting approved again.
 *
 * @param discordId User's Discord snowflake.
 * @param guildId Guild to revoke access for.
 * @returns Resolves once the update completes.
 */
export async function revokeApiKey(discordId: string, guildId: string): Promise<void> {
  await getPool().execute(
    `UPDATE streamdeck_key_guild_status SET status = 'revoked' WHERE discord_id = ? AND guild_id = ? AND status != 'denied'`,
    [discordId, guildId],
  );
}

/**
 * Lists pending Streamdeck API key requests for one guild.
 *
 * @param guildId Guild to list pending requests for.
 * @returns Pending guild-status rows for `guildId`, including requester names, oldest first.
 */
export async function getPendingRequests(guildId: string): Promise<StreamdeckKeyGuildStatusRow[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT s.discord_id, s.guild_id, s.status, s.requested_at, s.approved_at, s.approved_by,
            u.discord_name AS user_name, NULL AS approver_name
     FROM streamdeck_key_guild_status s
     LEFT JOIN \`user\` u ON u.discord_id = s.discord_id
     WHERE s.status = 'pending' AND s.guild_id = ?
     ORDER BY s.requested_at ASC`,
    [guildId],
  );
  return rows.map(mapStatusRow);
}

/**
 * Lists all Streamdeck API key guild-statuses for one guild.
 *
 * @param guildId Guild to list statuses for.
 * @returns Guild-status rows for `guildId`, including requester/approver names, ordered by status then request time.
 */
export async function getAllApiKeys(guildId: string): Promise<StreamdeckKeyGuildStatusRow[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT s.discord_id, s.guild_id, s.status, s.requested_at, s.approved_at, s.approved_by,
            u.discord_name AS user_name, a.discord_name AS approver_name
     FROM streamdeck_key_guild_status s
     LEFT JOIN \`user\` u ON u.discord_id = s.discord_id
     LEFT JOIN \`user\` a ON a.discord_id = s.approved_by
     WHERE s.guild_id = ?
     ORDER BY s.status ASC, s.requested_at ASC`,
    [guildId],
  );
  return rows.map(mapStatusRow);
}
