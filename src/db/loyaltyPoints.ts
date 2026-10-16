import mysql, { type PoolConnection } from 'mysql2/promise';
import { getPool, withTransaction } from './pool';

// ─── Defaults ─────────────────────────────────────────────────────────────────
// Applied when a streamer has no `loyalty_points_config` row. Mirrors
// `DEFAULT_PRICING_COOLDOWN_SECONDS` in rewardPricing.ts — a plain app default, not an
// env-configurable value, so it lives here rather than in shared/config.ts.

export const DEFAULT_POINTS_PER_MESSAGE = 1;
export const DEFAULT_POINTS_COOLDOWN_SECONDS = 60;
export const DEFAULT_POINTS_PER_SUB = 100;
export const DEFAULT_POINTS_PER_GIFT_SUB = 100;

// `loyalty_points.balance` is a plain INT column (see DATABASE-SCHEMA.md) — every
// write that can increase it clamps to this rather than allowed to overflow it.
const MAX_BALANCE = 2_147_483_647;

// ─── Types ───────────────────────────────────────────────────────────────────

/** One entry on a streamer's loyalty-points leaderboard. */
export interface LoyaltyPointsLeaderboardEntry {
  twitchUsername: string;
  balance: number;
}

/**
 * A streamer's loyalty-points configuration: the opt-in switch plus earn rates. Loyalty Points is
 * off by default — `enabled` must be explicitly set to `true` (via the web panel, which only
 * allows this once its prerequisites are met) before any viewer activity earns or spends points.
 */
export interface LoyaltyPointsConfig {
  enabled: boolean;
  pointsPerMessage: number;
  cooldownSeconds: number;
  pointsPerSub: number;
  pointsPerGiftSub: number;
}

/** Maps a raw `loyalty_points_config` table row to a {@link LoyaltyPointsConfig}. */
function mapLoyaltyPointsConfig(row: mysql.RowDataPacket): LoyaltyPointsConfig {
  return {
    enabled: !!row.enabled,
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
 * Returns the top `limit` viewers by balance for a streamer, highest first, leaving out any
 * account the streamer has excluded (see `loyalty_points_exclusion`).
 * @param streamerId - The streamer's `streamer.id`.
 * @param limit - Maximum number of entries to return.
 * @returns The leaderboard entries, highest balance first.
 */
export async function getLeaderboard(streamerId: number, limit: number): Promise<LoyaltyPointsLeaderboardEntry[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT lp.twitch_username, lp.balance FROM loyalty_points lp
     WHERE lp.streamer_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM loyalty_points_exclusion e
         WHERE e.streamer_id = lp.streamer_id AND e.twitch_username = lp.twitch_username
       )
     ORDER BY lp.balance DESC LIMIT ?`,
    [streamerId, limit],
  );
  return rows.map((row) => ({ twitchUsername: row.twitch_username, balance: row.balance }));
}

/**
 * Looks up a streamer's loyalty-points configuration.
 * @param streamerId - The streamer's `streamer.id`.
 * @returns The streamer's configuration, or null if they have no row — callers should treat a
 *   null result the same as `{ enabled: false, ... }`: Loyalty Points is off for that streamer.
 */
export async function getConfig(streamerId: number): Promise<LoyaltyPointsConfig | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT enabled, points_per_message, cooldown_seconds, points_per_sub, points_per_gift_sub FROM loyalty_points_config WHERE streamer_id = ?',
    [streamerId],
  );
  return rows[0] ? mapLoyaltyPointsConfig(rows[0]) : null;
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Atomically adjusts (adds or subtracts) a viewer's loyalty-points balance, creating their row
 * if it doesn't exist yet, and clamps the result to the `balance` column's valid range: never
 * below 0, never above {@link MAX_BALANCE} (mirrors the clamp {@link resolveGambleOutcome} does
 * for a winning payout — without it here too, a large configured per-message/sub/gift-sub rate
 * could push `balance` past the signed `INT` range on an ordinary award). Safe under concurrent
 * calls for the same viewer — the clamp and the read-back both happen inside the same upsert.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The viewer's Twitch login.
 * @param delta - Amount to add (positive) or subtract (negative).
 * @returns The viewer's balance after the adjustment.
 */
export async function adjustBalance(streamerId: number, twitchUsername: string, delta: number): Promise<number> {
  return withTransaction((conn) => adjustBalanceOnConn(conn, streamerId, twitchUsername, delta));
}

/**
 * {@link adjustBalance} on a connection the caller already holds, so the adjustment commits or
 * rolls back together with the caller's other writes (e.g. an advanced command refund, which must
 * not mark a use refunded unless the points actually come back).
 * @param conn - The caller's transaction connection.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The viewer's Twitch login.
 * @param delta - Amount to add (positive) or subtract (negative).
 * @returns The viewer's balance after the adjustment.
 */
export async function adjustBalanceOnConn(
  conn: PoolConnection,
  streamerId: number,
  twitchUsername: string,
  delta: number,
): Promise<number> {
  await conn.execute<mysql.ResultSetHeader>(
    `INSERT INTO loyalty_points (streamer_id, twitch_username, balance)
     VALUES (?, ?, LAST_INSERT_ID(LEAST(GREATEST(?, 0), ?)))
     AS new_row
     ON DUPLICATE KEY UPDATE balance = LAST_INSERT_ID(LEAST(GREATEST(loyalty_points.balance + ?, 0), ?))`,
    [streamerId, twitchUsername, delta, MAX_BALANCE, delta, MAX_BALANCE],
  );
  const [rows] = await conn.execute<mysql.RowDataPacket[]>('SELECT LAST_INSERT_ID() AS balance');
  // LAST_INSERT_ID() is a BIGINT expression, so the pool's bigNumberStrings setting can return
  // it as a string even though `balance` itself is a plain INT column — parse it back with
  // Number() rather than trusting the driver's JS type. Safe here: this is a points balance
  // adjusted by small per-message/per-gamble amounts, nowhere near Number.MAX_SAFE_INTEGER
  // (unlike a Discord snowflake, which is why that case is never parsed back this way
  // elsewhere in this codebase). Mirrors incrementCounter's identical comment in counters.ts.
  return Number(rows[0]!.balance); // SELECT LAST_INSERT_ID() always returns one row
}

/**
 * Atomically resolves a `!gamble` bet: debits `bet` from the viewer's balance (conditionally,
 * failing if their balance is too low), and, only if `won` is true, credits back `2 * bet` (the
 * returned stake plus profit), all within one
 * transaction. Keeping both writes in the same transaction is what CodeRabbit's review flagged
 * as missing from an earlier version of this flow (debit-then-separately-credit): a viewer could
 * otherwise lose their stake to a debit that committed while a later, separate credit call failed
 * (for instance after a crash) and left them with no payout. A winning credit that would push the
 * balance above the column's INT range is clamped to {@link MAX_BALANCE} rather than attempted
 * and failed, so the single transaction here never has a reason to roll back after the debit
 * succeeds.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The gambling viewer's Twitch login.
 * @param bet - The already-validated, positive bet amount.
 * @param won - Whether the coin flip was a win.
 * @returns The viewer's balance after the bet resolves, or null if their balance was too low to
 *   cover `bet` (including a viewer with no row at all).
 */
export async function resolveGambleOutcome(
  streamerId: number,
  twitchUsername: string,
  bet: number,
  won: boolean,
): Promise<number | null> {
  return withTransaction(async (conn) => {
    const [debitResult] = await conn.execute<mysql.ResultSetHeader>(
      `UPDATE loyalty_points
       SET balance = LAST_INSERT_ID(balance - ?)
       WHERE streamer_id = ? AND twitch_username = ? AND balance >= ?`,
      [bet, streamerId, twitchUsername, bet],
    );
    if (debitResult.affectedRows === 0) return null;

    if (won) {
      await conn.execute<mysql.ResultSetHeader>(
        `UPDATE loyalty_points
         SET balance = LAST_INSERT_ID(LEAST(balance + ?, ?))
         WHERE streamer_id = ? AND twitch_username = ?`,
        [2 * bet, MAX_BALANCE, streamerId, twitchUsername],
      );
    }

    const [rows] = await conn.execute<mysql.RowDataPacket[]>('SELECT LAST_INSERT_ID() AS balance');
    // See adjustBalanceOnConn's identical comment: LAST_INSERT_ID() is a BIGINT expression that can
    // come back as a string, safely parsed back here since this is a bounded points balance.
    return Number(rows[0]!.balance); // SELECT LAST_INSERT_ID() always returns one row
  });
}

/**
 * Atomically spends `cost` points from a viewer's balance, only if they have at least that many —
 * the same conditional debit {@link resolveGambleOutcome} uses, so two concurrent spends can't
 * both pass a balance check made beforehand.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The viewer's Twitch login.
 * @param cost - The positive number of points to spend.
 * @returns The viewer's balance after spending, or null if it was too low (including a viewer
 *   with no row at all).
 */
export async function spendBalance(streamerId: number, twitchUsername: string, cost: number): Promise<number | null> {
  return withTransaction(async (conn) => {
    const [result] = await conn.execute<mysql.ResultSetHeader>(
      `UPDATE loyalty_points
       SET balance = LAST_INSERT_ID(balance - ?)
       WHERE streamer_id = ? AND twitch_username = ? AND balance >= ?`,
      [cost, streamerId, twitchUsername, cost],
    );
    if (result.affectedRows === 0) return null;
    const [rows] = await conn.execute<mysql.RowDataPacket[]>('SELECT LAST_INSERT_ID() AS balance');
    // See adjustBalanceOnConn's identical comment: LAST_INSERT_ID() is a BIGINT expression that can
    // come back as a string, safely parsed back here since this is a bounded points balance.
    return Number(rows[0]!.balance); // SELECT LAST_INSERT_ID() always returns one row
  });
}

/**
 * Creates or replaces a streamer's loyalty-points earn-rate configuration.
 * @param streamerId - The streamer's `streamer.id`.
 * @param config - The new configuration.
 * @returns Resolves once the write completes.
 */
export async function setConfig(streamerId: number, config: LoyaltyPointsConfig): Promise<void> {
  await getPool().execute(
    `INSERT INTO loyalty_points_config (streamer_id, enabled, points_per_message, cooldown_seconds, points_per_sub, points_per_gift_sub)
     VALUES (?, ?, ?, ?, ?, ?)
     AS new_row
     ON DUPLICATE KEY UPDATE
       enabled = new_row.enabled,
       points_per_message = new_row.points_per_message,
       cooldown_seconds = new_row.cooldown_seconds,
       points_per_sub = new_row.points_per_sub,
       points_per_gift_sub = new_row.points_per_gift_sub`,
    [streamerId, config.enabled, config.pointsPerMessage, config.cooldownSeconds, config.pointsPerSub, config.pointsPerGiftSub],
  );
}

/**
 * Returns every streamer's loyalty-points configuration, for building the lookup cache in
 * {@link ./loyaltyPointsCache.ts}.
 * @returns Every configured streamer's id and configuration.
 */
export async function getAllConfigs(): Promise<{ streamerId: number; config: LoyaltyPointsConfig }[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT streamer_id, enabled, points_per_message, cooldown_seconds, points_per_sub, points_per_gift_sub FROM loyalty_points_config',
  );
  return rows.map((row) => ({ streamerId: row.streamer_id, config: mapLoyaltyPointsConfig(row) }));
}
