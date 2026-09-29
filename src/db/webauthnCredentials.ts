import mysql from 'mysql2/promise';
import { getPool, withTransaction } from './pool';
import { isMysqlDuplicateEntryError } from './commandStringUtils';

/** A passkey as shown in the user's settings page — no key material. */
export interface PasskeySummary {
  credentialId: string;
  deviceLabel: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** A stored passkey with everything needed to verify an authentication assertion against it. */
export interface StoredPasskey {
  credentialId: string;
  discordId: string;
  /** base64url WebAuthn user handle registered with this credential. */
  userHandle: string;
  publicKey: Uint8Array<ArrayBuffer>;
  /** WebAuthn signature counter — a 32-bit unsigned value, stored as `INT UNSIGNED`, so a plain number. */
  signCount: number;
  transports: string[];
}

/** Fields needed to store a newly-registered passkey. */
export interface NewPasskey {
  credentialId: string;
  discordId: string;
  /** base64url WebAuthn user handle put in the registration options. */
  userHandle: string;
  publicKey: Uint8Array;
  signCount: number;
  transports: string[];
  deviceLabel: string;
}

/**
 * Lists a user's passkeys, newest first, for the settings page.
 * @param discordId - The owning user's Discord ID.
 * @returns The user's passkeys, without key material.
 */
export async function listPasskeysForUser(discordId: string): Promise<PasskeySummary[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT credential_id, device_label, created_at, last_used_at
     FROM webauthn_credentials WHERE discord_id = ? ORDER BY created_at DESC`,
    [discordId],
  );
  return rows.map((r) => ({
    credentialId: String(r.credential_id),
    deviceLabel: String(r.device_label),
    createdAt: r.created_at as Date,
    lastUsedAt: (r.last_used_at as Date | null) ?? null,
  }));
}

/**
 * Lists the credential IDs (with user handle and transports) a user already has, so registration
 * can reuse their user handle and tell the browser not to create a second passkey on an
 * authenticator that already holds one.
 * @param discordId - The owning user's Discord ID.
 * @returns Credential ID, user handle and transports for each of the user's passkeys.
 */
export async function listPasskeyDescriptorsForUser(
  discordId: string,
): Promise<{ credentialId: string; userHandle: string; transports: string[] }[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT credential_id, user_handle, transports FROM webauthn_credentials WHERE discord_id = ?',
    [discordId],
  );
  return rows.map((r) => ({
    credentialId: String(r.credential_id),
    userHandle: String(r.user_handle),
    transports: parseTransports(r.transports as string | null),
  }));
}

/**
 * Looks up a passkey by its credential ID.
 * @param credentialId - base64url credential ID from the authenticator's assertion.
 * @returns The stored passkey, or null if none matches.
 */
export async function findPasskey(credentialId: string): Promise<StoredPasskey | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT credential_id, discord_id, user_handle, public_key, sign_count, transports
     FROM webauthn_credentials WHERE credential_id = ?`,
    [credentialId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    credentialId: String(r.credential_id),
    discordId: String(r.discord_id),
    userHandle: String(r.user_handle),
    publicKey: new Uint8Array(r.public_key as Buffer),
    signCount: Number(r.sign_count),
    transports: parseTransports(r.transports as string | null),
  };
}

/** Outcome of {@link insertPasskey}. */
export type InsertPasskeyResult = 'inserted' | 'duplicate' | 'limit';

/**
 * Stores a newly-registered passkey, enforcing the per-user passkey limit atomically: the owner's
 * `user` row is locked (`FOR UPDATE`) before counting, so two concurrent registrations for the
 * same user serialise instead of both slipping in under the limit.
 * @param passkey - The verified registration's credential data and the owner's chosen label.
 * @param maxPerUser - The most passkeys a user may hold; the insert is refused at this count.
 * @returns `'inserted'` if stored, `'limit'` if the user already has `maxPerUser` passkeys, or
 *   `'duplicate'` if a passkey with that credential ID already exists.
 */
export async function insertPasskey(passkey: NewPasskey, maxPerUser: number): Promise<InsertPasskeyResult> {
  try {
    return await withTransaction(async (conn) => {
      await conn.execute('SELECT discord_id FROM `user` WHERE discord_id = ? FOR UPDATE', [passkey.discordId]);
      const [countRows] = await conn.execute<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS count FROM webauthn_credentials WHERE discord_id = ?',
        [passkey.discordId],
      );
      // COUNT(*) comes back as a BIGINT string (bigNumberStrings), but it's bounded by the per-user
      // passkey limit (single digits), so parsing it to a number here is safe.
      if (Number.parseInt(String(countRows[0].count), 10) >= maxPerUser) return 'limit';

      await conn.execute(
        `INSERT INTO webauthn_credentials
           (credential_id, discord_id, user_handle, public_key, sign_count, transports, device_label)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          passkey.credentialId,
          passkey.discordId,
          passkey.userHandle,
          Buffer.from(passkey.publicKey),
          passkey.signCount,
          passkey.transports.length > 0 ? passkey.transports.join(',') : null,
          passkey.deviceLabel,
        ],
      );
      return 'inserted';
    });
  } catch (err) {
    if (isMysqlDuplicateEntryError(err)) return 'duplicate';
    throw err;
  }
}

/**
 * Records a successful sign-in with a passkey: raises the stored signature counter to the
 * authenticator's new value (never lowers it) and stamps `last_used_at`.
 * @param credentialId - The passkey that was used.
 * @param signCount - The new signature counter reported by the authenticator.
 */
export async function recordPasskeyUse(credentialId: string, signCount: number): Promise<void> {
  await getPool().execute(
    // GREATEST keeps the counter monotonic: two sign-ins racing each other can't write an older
    // value over a newer one, which would weaken the library's cloned-authenticator check.
    'UPDATE webauthn_credentials SET sign_count = GREATEST(sign_count, ?), last_used_at = NOW() WHERE credential_id = ?',
    [signCount, credentialId],
  );
}

/**
 * Deletes one of a user's passkeys. Scoped by `discord_id` so a user can't delete someone
 * else's passkey by guessing its credential ID.
 * @param discordId - The owning user's Discord ID.
 * @param credentialId - The passkey to delete.
 * @returns True if a passkey was deleted, false if the user has no passkey with that ID.
 */
export async function deletePasskey(discordId: string, credentialId: string): Promise<boolean> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    'DELETE FROM webauthn_credentials WHERE discord_id = ? AND credential_id = ?',
    [discordId, credentialId],
  );
  return result.affectedRows > 0;
}

/**
 * Splits the stored comma-separated transports list.
 * @param raw - The `transports` column value.
 * @returns The transport names, or an empty array when none were stored.
 */
function parseTransports(raw: string | null): string[] {
  return raw ? raw.split(',').filter((t) => t.length > 0) : [];
}
