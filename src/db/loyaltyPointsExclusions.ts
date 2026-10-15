import mysql from 'mysql2/promise';
import { getPool } from './pool';

// Per-streamer list of Twitch accounts (in practice, chat bots) that never earn loyalty points
// and are hidden from the leaderboard. A pure DB layer with no cache knowledge — the lookup cache
// lives in loyaltyPointsExclusionCache.ts and invalidation in loyaltyPointsExclusionWrites.ts,
// same split as loyaltyPoints.ts/loyaltyPointsCache.ts/loyaltyPointsWrites.ts.

/**
 * Normalizes a Twitch login for storage/comparison. Twitch logins are case-insensitive and chat
 * delivers them lowercased, so storing them lowercased keeps every lookup a plain equality check.
 * @param twitchUsername - The Twitch login as entered or received.
 * @returns The trimmed, lowercased login.
 */
export function normalizeExcludedUsername(twitchUsername: string): string {
  return twitchUsername.trim().toLowerCase();
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Lists the accounts a streamer has excluded from loyalty points, alphabetically.
 * @param streamerId - The streamer's `streamer.id`.
 * @returns The excluded Twitch logins.
 */
export async function getExclusions(streamerId: number): Promise<string[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT twitch_username FROM loyalty_points_exclusion WHERE streamer_id = ? ORDER BY twitch_username',
    [streamerId],
  );
  return rows.map((row) => row.twitch_username);
}

/**
 * Returns every streamer's excluded accounts, for building the lookup cache in
 * {@link ./loyaltyPointsExclusionCache.ts}.
 * @returns One entry per (streamer, excluded login) pair.
 */
export async function getAllExclusions(): Promise<{ streamerId: number; twitchUsername: string }[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT streamer_id, twitch_username FROM loyalty_points_exclusion',
  );
  return rows.map((row) => ({ streamerId: row.streamer_id, twitchUsername: row.twitch_username }));
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Excludes an account from a streamer's loyalty points. Idempotent: excluding an
 * already-excluded account is a no-op. The account's existing balance row is kept (just hidden
 * from the leaderboard), so un-excluding it later restores it as it was.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The Twitch login to exclude.
 * @returns Resolves once the write completes.
 */
export async function addExclusion(streamerId: number, twitchUsername: string): Promise<void> {
  await getPool().execute(
    'INSERT IGNORE INTO loyalty_points_exclusion (streamer_id, twitch_username) VALUES (?, ?)',
    [streamerId, normalizeExcludedUsername(twitchUsername)],
  );
}

/**
 * Removes an account from a streamer's loyalty-points exclusion list. A no-op if it wasn't excluded.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The Twitch login to un-exclude.
 * @returns Resolves once the write completes.
 */
export async function removeExclusion(streamerId: number, twitchUsername: string): Promise<void> {
  await getPool().execute(
    'DELETE FROM loyalty_points_exclusion WHERE streamer_id = ? AND twitch_username = ?',
    [streamerId, normalizeExcludedUsername(twitchUsername)],
  );
}
