import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { buildInClausePlaceholders } from './commandStringUtils';

/** One recorded price/demand point for a reward, at a point in time. */
export interface RewardPricingHistoryPoint {
  /** Epoch ms as a string — BIGINT column; never coerce with Number() at this layer. */
  recorded_at: string;
  cost: number;
  demand: number;
}

// Slightly larger than the largest selectable range on /channel-points (24h), so a
// full 24h history is always available regardless of when within the retention
// window the last prune ran.
const RETENTION_MS = 25 * 60 * 60 * 1000;

/**
 * Maps a `reward_pricing_history` row to a {@link RewardPricingHistoryPoint}.
 * @param r - Row containing `recorded_at`, `cost`, and `demand` columns.
 * @returns The point, with `recorded_at` coerced to a string and `demand` to a number.
 */
function mapRow(r: mysql.RowDataPacket): RewardPricingHistoryPoint {
  return { recorded_at: String(r.recorded_at), cost: r.cost, demand: Number(r.demand) };
}

/**
 * Records a price/demand point for a reward, then prunes points older than the
 * retention window for that same reward so the table stays bounded to roughly the
 * largest selectable history range. The insert and prune are independent of each
 * other, so they run concurrently rather than as two sequential round-trips.
 *
 * @param rewardPricingId - Primary key of the `reward_pricing` row this point belongs to.
 * @param cost - The computed price at `recordedAtMs`.
 * @param demand - The demand value at `recordedAtMs`.
 * @param recordedAtMs - Epoch ms this point was computed as of.
 */
export async function recordPricingHistory(
  rewardPricingId: number,
  cost: number,
  demand: number,
  recordedAtMs: number,
): Promise<void> {
  await Promise.all([
    getPool().execute(
      `INSERT INTO reward_pricing_history (reward_pricing_id, recorded_at, cost, demand) VALUES (?, ?, ?, ?)`,
      [rewardPricingId, recordedAtMs, cost, demand],
    ),
    getPool().execute(
      `DELETE FROM reward_pricing_history WHERE reward_pricing_id = ? AND recorded_at < ?`,
      [rewardPricingId, recordedAtMs - RETENTION_MS],
    ),
  ]);
}

/**
 * Returns recorded price/demand points for a reward at or after `sinceMs`, oldest first.
 *
 * @param rewardPricingId - Primary key of the `reward_pricing` row.
 * @param sinceMs - Epoch ms lower bound (inclusive) for returned points.
 */
export async function getPricingHistory(rewardPricingId: number, sinceMs: number): Promise<RewardPricingHistoryPoint[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT recorded_at, cost, demand FROM reward_pricing_history
     WHERE reward_pricing_id = ? AND recorded_at >= ?
     ORDER BY recorded_at ASC`,
    [rewardPricingId, sinceMs],
  );
  return rows.map(mapRow);
}

/**
 * Returns recorded price/demand points for multiple rewards at or after `sinceMs` in a
 * single query, grouped by `reward_pricing_id` (oldest first within each group). Used by
 * the Channel Points admin page to chart every reward's history without one query per
 * reward.
 *
 * @param rewardPricingIds - Primary keys of the `reward_pricing` rows to fetch history for.
 * @param sinceMs - Epoch ms lower bound (inclusive) for returned points.
 * @returns A map from `reward_pricing_id` to its points; ids with no points are absent.
 */
export async function getPricingHistoryForRewards(
  rewardPricingIds: number[],
  sinceMs: number,
): Promise<Map<number, RewardPricingHistoryPoint[]>> {
  const byRewardId = new Map<number, RewardPricingHistoryPoint[]>();
  if (rewardPricingIds.length === 0) return byRewardId;

  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT reward_pricing_id, recorded_at, cost, demand FROM reward_pricing_history
     WHERE reward_pricing_id IN (${buildInClausePlaceholders(rewardPricingIds.length)}) AND recorded_at >= ?
     ORDER BY reward_pricing_id, recorded_at ASC`,
    [...rewardPricingIds, sinceMs],
  );

  for (const r of rows) {
    const rewardPricingId = r.reward_pricing_id as number;
    const point = mapRow(r);
    const existing = byRewardId.get(rewardPricingId);
    if (existing) existing.push(point);
    else byRewardId.set(rewardPricingId, [point]);
  }

  return byRewardId;
}
