import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { fromBit } from './utils';

/** A reward's dynamic-pricing configuration and current demand state. */
export interface RewardPricingRow {
  id: number;
  streamer_id: number;
  twitch_reward_id: string;
  enabled: boolean;
  base_cost: number;
  cooldown_seconds: number;
  max_multiplier: number;
  curve: number;
  demand: number;
  /** Epoch ms as a string — BIGINT column; never coerce with Number() at this layer. */
  demand_updated_at: string;
  last_pushed_cost: number | null;
}

/** Config fields a streamer can edit for one reward via the admin UI. */
export interface RewardPricingInput {
  enabled: boolean;
  base_cost: number;
  cooldown_seconds: number;
  max_multiplier: number;
  curve: number;
}

/** Bot-wide settings shared by every reward's demand calculations. */
export interface GlobalPricingSettings {
  decay_half_life_periods: number;
  redemption_increment: number;
}

const DEFAULT_GLOBAL_SETTINGS: GlobalPricingSettings = {
  decay_half_life_periods: 3,
  redemption_increment: 0.1,
};

function mapRow(r: mysql.RowDataPacket): RewardPricingRow {
  return {
    id: r.id,
    streamer_id: r.streamer_id,
    twitch_reward_id: r.twitch_reward_id,
    enabled: fromBit(r.enabled),
    base_cost: r.base_cost,
    cooldown_seconds: r.cooldown_seconds,
    max_multiplier: Number(r.max_multiplier),
    curve: Number(r.curve),
    demand: Number(r.demand),
    demand_updated_at: String(r.demand_updated_at),
    last_pushed_cost: r.last_pushed_cost == null ? null : Number(r.last_pushed_cost),
  };
}

const REWARD_PRICING_SELECT = `
  id, streamer_id, twitch_reward_id, enabled, base_cost, cooldown_seconds,
  max_multiplier, curve, demand, demand_updated_at, last_pushed_cost`;

/**
 * Look up a single reward's pricing config/demand row, or null if not configured.
 *
 * @param streamerId - DB row ID of the owning streamer.
 * @param twitchRewardId - Twitch reward UUID.
 */
export async function getPricingForReward(streamerId: number, twitchRewardId: string): Promise<RewardPricingRow | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${REWARD_PRICING_SELECT} FROM reward_pricing WHERE streamer_id = ? AND twitch_reward_id = ?`,
    [streamerId, twitchRewardId],
  );
  return rows.length === 0 ? null : mapRow(rows[0]);
}

/**
 * List every reward pricing row (configured or not yet enabled) belonging to a streamer.
 *
 * @param streamerId - DB row ID of the streamer.
 */
export async function getPricingConfigsForStreamer(streamerId: number): Promise<RewardPricingRow[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${REWARD_PRICING_SELECT} FROM reward_pricing WHERE streamer_id = ? ORDER BY id`,
    [streamerId],
  );
  return rows.map(mapRow);
}

/**
 * List every reward pricing row across all streamers where dynamic pricing is enabled.
 * Used by the periodic decay scheduler to find rows that need a decay tick.
 */
export async function getAllEnabledPricingRows(): Promise<RewardPricingRow[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${REWARD_PRICING_SELECT} FROM reward_pricing WHERE enabled = 1 ORDER BY streamer_id`,
  );
  return rows.map(mapRow);
}

/**
 * Create or update a reward's pricing config. Only touches the config columns
 * (enabled/base_cost/cooldown_seconds/max_multiplier/curve) — demand, demand_updated_at,
 * and last_pushed_cost are left untouched on an update so editing config never resets
 * in-flight demand state. New rows start at demand=0 with demand_updated_at=now.
 *
 * @param streamerId - DB row ID of the owning streamer.
 * @param twitchRewardId - Twitch reward UUID.
 * @param input - The config fields to save.
 */
export async function upsertPricingConfig(
  streamerId: number,
  twitchRewardId: string,
  input: RewardPricingInput,
): Promise<void> {
  await getPool().execute(
    `INSERT INTO reward_pricing
       (streamer_id, twitch_reward_id, enabled, base_cost, cooldown_seconds, max_multiplier, curve, demand_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       enabled=new_row.enabled, base_cost=new_row.base_cost, cooldown_seconds=new_row.cooldown_seconds,
       max_multiplier=new_row.max_multiplier, curve=new_row.curve`,
    [
      streamerId, twitchRewardId,
      input.enabled ? 1 : 0, input.base_cost, input.cooldown_seconds, input.max_multiplier, input.curve,
      Date.now(),
    ],
  );
}

/**
 * Persist a recalculated demand value (and, if it changed, the last cost pushed to Twitch).
 * Shared by the redemption hook and the periodic decay scheduler — the only writer of
 * demand state, keeping it separate from config edits (see upsertPricingConfig).
 *
 * @param streamerId - DB row ID of the owning streamer.
 * @param twitchRewardId - Twitch reward UUID.
 * @param demand - The newly computed demand value.
 * @param demandUpdatedAtMs - Epoch ms this demand value was computed as of.
 * @param lastPushedCost - The cost last pushed to Twitch, or null if none has been pushed yet.
 */
export async function recordPricingUpdate(
  streamerId: number,
  twitchRewardId: string,
  demand: number,
  demandUpdatedAtMs: number,
  lastPushedCost: number | null,
): Promise<void> {
  await getPool().execute(
    `UPDATE reward_pricing
     SET demand = ?, demand_updated_at = ?, last_pushed_cost = ?
     WHERE streamer_id = ? AND twitch_reward_id = ?`,
    [demand, demandUpdatedAtMs, lastPushedCost, streamerId, twitchRewardId],
  );
}

/**
 * Delete a reward's pricing config, scoped to the owning streamer.
 *
 * @param id - Primary key of the `reward_pricing` row.
 * @param streamerId - DB row ID of the owning streamer.
 */
export async function deletePricingConfig(id: number, streamerId: number): Promise<void> {
  await getPool().execute(
    `DELETE FROM reward_pricing WHERE id = ? AND streamer_id = ?`,
    [id, streamerId],
  );
}

/**
 * Insert the default global pricing settings row (id=1) if one does not already exist.
 * Safe to call multiple times; called once at bot startup.
 */
export async function initGlobalPricingSettings(): Promise<void> {
  const s = DEFAULT_GLOBAL_SETTINGS;
  await getPool().execute(
    `INSERT IGNORE INTO pricing_global_settings (id, decay_half_life_periods, redemption_increment)
     VALUES (1, ?, ?)`,
    [s.decay_half_life_periods, s.redemption_increment],
  );
}

/**
 * Read the global pricing settings. Falls back to hardcoded defaults (without throwing)
 * if the singleton row is missing, e.g. before initGlobalPricingSettings has run.
 */
export async function getGlobalPricingSettings(): Promise<GlobalPricingSettings> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT decay_half_life_periods, redemption_increment FROM pricing_global_settings WHERE id = 1`,
  );
  if (rows.length === 0) return { ...DEFAULT_GLOBAL_SETTINGS };
  return {
    decay_half_life_periods: Number(rows[0].decay_half_life_periods),
    redemption_increment: Number(rows[0].redemption_increment),
  };
}

/**
 * Upsert the global pricing settings row (id=1).
 *
 * @param settings - The new global decay/increment settings.
 */
export async function saveGlobalPricingSettings(settings: GlobalPricingSettings): Promise<void> {
  await getPool().execute(
    `INSERT INTO pricing_global_settings (id, decay_half_life_periods, redemption_increment)
     VALUES (1, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       decay_half_life_periods=new_row.decay_half_life_periods, redemption_increment=new_row.redemption_increment`,
    [settings.decay_half_life_periods, settings.redemption_increment],
  );
}
