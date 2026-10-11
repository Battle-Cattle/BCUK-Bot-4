import mysql from 'mysql2/promise';
import { getPool, withTransaction } from './pool';

// ─── Defaults ─────────────────────────────────────────────────────────────────
// Applied when a streamer has no `loyalty_points_config` row. Mirrors
// `DEFAULT_PRICING_COOLDOWN_SECONDS` in rewardPricing.ts — a plain app default, not an
// env-configurable value, so it lives here rather than in shared/config.ts.

export const DEFAULT_POINTS_PER_MESSAGE = 1;
export const DEFAULT_POINTS_COOLDOWN_SECONDS = 60;
export const DEFAULT_POINTS_PER_SUB = 100;
export const DEFAULT_POINTS_PER_GIFT_SUB = 100;

// ─── Types ───────────────────────────────────────────────────────────────────

/** One entry on a streamer's loyalty-points leaderboard. */
export interface LoyaltyPointsLeaderboardEntry {
  twitchUsername: string;
  balance: number;
}

/** A streamer's loyalty-points earn-rate configuration. */
export interface LoyaltyPointsConfig {
  pointsPerMessage: number;
  cooldownSeconds: number;
  pointsPerSub: number;
  pointsPerGiftSub: number;
}

/** Maps a raw `loyalty_points_config` table row to a {@link LoyaltyPointsConfig}. */
function mapLoyaltyPointsConfig(row: mysql.RowDataPacket): LoyaltyPointsConfig {
  return {
    pointsPerMessage: row.points_per_message,
    cooldownSeconds: row.cooldown_seconds,
    pointsPerSub: row.points_per_sub,
    pointsPerGiftSub: row.points_per_gift_sub,
  };
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Looks up a viewer's current loyalty-points balance for a streamer.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The viewer's Twitch login.
 * @returns The viewer's balance, or 0 if they have no row yet.
 */
export async function getBalance(streamerId: number, twitchUsername: string): Promise<number> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT balance FROM loyalty_points WHERE streamer_id = ? AND twitch_username = ?',
    [streamerId, twitchUsername],
  );
  return rows[0] ? rows[0].balance : 0;
}

/**
 * Returns the top `limit` viewers by balance for a streamer, highest first.
 * @param streamerId - The streamer's `streamer.id`.
 * @param limit - Maximum number of entries to return.
 * @returns The leaderboard entries, highest balance first.
 */
export async function getLeaderboard(streamerId: number, limit: number): Promise<LoyaltyPointsLeaderboardEntry[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT twitch_username, balance FROM loyalty_points WHERE streamer_id = ? ORDER BY balance DESC LIMIT ?',
    [streamerId, limit],
  );
  return rows.map((row) => ({ twitchUsername: row.twitch_username, balance: row.balance }));
}

/**
 * Looks up a streamer's loyalty-points earn-rate configuration.
 * @param streamerId - The streamer's `streamer.id`.
 * @returns The streamer's configuration, or null if they have no row (callers should fall back
 *   to the app's default constants).
 */
export async function getConfig(streamerId: number): Promise<LoyaltyPointsConfig | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT points_per_message, cooldown_seconds, points_per_sub, points_per_gift_sub FROM loyalty_points_config WHERE streamer_id = ?',
    [streamerId],
  );
  return rows[0] ? mapLoyaltyPointsConfig(rows[0]) : null;
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Atomically adjusts (adds or subtracts) a viewer's loyalty-points balance, creating their row
 * if it doesn't exist yet, and clamps the result to never go below 0. Safe under concurrent
 * calls for the same viewer — the clamp and the read-back both happen inside the same upsert.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The viewer's Twitch login.
 * @param delta - Amount to add (positive) or subtract (negative).
 * @returns The viewer's balance after the adjustment.
 */
export async function adjustBalance(streamerId: number, twitchUsername: string, delta: number): Promise<number> {
  const newBalance = await withTransaction(async (conn) => {
    await conn.execute<mysql.ResultSetHeader>(
      `INSERT INTO loyalty_points (streamer_id, twitch_username, balance)
       VALUES (?, ?, LAST_INSERT_ID(GREATEST(?, 0)))
       AS new_row
       ON DUPLICATE KEY UPDATE balance = LAST_INSERT_ID(GREATEST(loyalty_points.balance + ?, 0))`,
      [streamerId, twitchUsername, delta, delta],
    );
    const [rows] = await conn.execute<mysql.RowDataPacket[]>('SELECT LAST_INSERT_ID() AS balance');
    // LAST_INSERT_ID() is a BIGINT expression, so the pool's bigNumberStrings setting can return
    // it as a string even though `balance` itself is a plain INT column — parse it back with
    // Number() rather than trusting the driver's JS type. Safe here: this is a points balance
    // adjusted by small per-message/per-gamble amounts, nowhere near Number.MAX_SAFE_INTEGER
    // (unlike a Discord snowflake, which is why that case is never parsed back this way
    // elsewhere in this codebase). Mirrors incrementCounter's identical comment in counters.ts.
    return Number(rows[0]!.balance); // SELECT LAST_INSERT_ID() always returns one row
  });
  return newBalance;
}

/**
 * Creates or replaces a streamer's loyalty-points earn-rate configuration.
 * @param streamerId - The streamer's `streamer.id`.
 * @param config - The new configuration.
 * @returns Resolves once the write completes.
 */
export async function setConfig(streamerId: number, config: LoyaltyPointsConfig): Promise<void> {
  await getPool().execute(
    `INSERT INTO loyalty_points_config (streamer_id, points_per_message, cooldown_seconds, points_per_sub, points_per_gift_sub)
     VALUES (?, ?, ?, ?, ?)
     AS new_row
     ON DUPLICATE KEY UPDATE
       points_per_message = new_row.points_per_message,
       cooldown_seconds = new_row.cooldown_seconds,
       points_per_sub = new_row.points_per_sub,
       points_per_gift_sub = new_row.points_per_gift_sub`,
    [streamerId, config.pointsPerMessage, config.cooldownSeconds, config.pointsPerSub, config.pointsPerGiftSub],
  );
}

/**
 * Returns every streamer's loyalty-points configuration, for building the lookup cache in
 * {@link ./loyaltyPointsCache.ts}.
 * @returns Every configured streamer's id and configuration.
 */
export async function getAllConfigs(): Promise<{ streamerId: number; config: LoyaltyPointsConfig }[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT streamer_id, points_per_message, cooldown_seconds, points_per_sub, points_per_gift_sub FROM loyalty_points_config',
  );
  return rows.map((row) => ({ streamerId: row.streamer_id, config: mapLoyaltyPointsConfig(row) }));
}
