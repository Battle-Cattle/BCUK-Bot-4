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
  /** Rounds the computed price to the nearest multiple of this many points (e.g. 5 or 10). 0 disables rounding. */
  round_to_nearest: number;
  demand: number;
  /** Epoch ms as a string — BIGINT column; never coerce with Number() at this layer. */
  demand_updated_at: string;
  last_pushed_cost: number | null;
  /** True once Twitch has returned 403 for this reward — it was created outside this app and can never be managed by it. */
  twitch_unsupported: boolean;
}

/** Config fields a streamer can edit for one reward via the admin UI. */
export interface RewardPricingInput {
  enabled: boolean;
  base_cost: number;
  cooldown_seconds: number;
  max_multiplier: number;
  curve: number;
  /** Rounds the computed price to the nearest multiple of this many points (e.g. 5 or 10). 0 disables rounding. */
  round_to_nearest: number;
}

/** Per-streamer settings shared by every one of their rewards' demand calculations. */
export interface StreamerPricingSettings {
  /** Fixed duration (seconds) of inactivity for demand to halve — the same for every reward, regardless of its own cooldown. */
  half_life_seconds: number;
  /** Redemptions at a reward's own cooldown frequency reach 100% demand after this many half-lives. */
  time_to_max_multiplier: number;
}

const DEFAULT_STREAMER_PRICING_SETTINGS: StreamerPricingSettings = {
  half_life_seconds: 1800, // 30 minutes
  time_to_max_multiplier: 2,
};

/** Fallback cooldown (seconds) used for a reward's pricing math when it has no Twitch-enforced cooldown. */
export const DEFAULT_PRICING_COOLDOWN_SECONDS = 60;

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
    round_to_nearest: r.round_to_nearest,
    demand: Number(r.demand),
    demand_updated_at: String(r.demand_updated_at),
    last_pushed_cost: r.last_pushed_cost == null ? null : Number(r.last_pushed_cost),
    twitch_unsupported: fromBit(r.twitch_unsupported),
  };
}

const REWARD_PRICING_SELECT = `
  id, streamer_id, twitch_reward_id, enabled, base_cost, cooldown_seconds,
  max_multiplier, curve, round_to_nearest, demand, demand_updated_at, last_pushed_cost, twitch_unsupported`;

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
 * Look up a single reward's pricing config by its primary key, scoped to the owning
 * streamer, or null if not found.
 *
 * @param id - Primary key of the `reward_pricing` row.
 * @param streamerId - DB row ID of the owning streamer.
 */
export async function getPricingConfigById(id: number, streamerId: number): Promise<RewardPricingRow | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${REWARD_PRICING_SELECT} FROM reward_pricing WHERE id = ? AND streamer_id = ?`,
    [id, streamerId],
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
 * (enabled/base_cost/cooldown_seconds/max_multiplier/curve/round_to_nearest) — demand,
 * demand_updated_at, and last_pushed_cost are left untouched on an update so editing config
 * never resets in-flight demand state. New rows start at demand=0 with demand_updated_at=now.
 * Always clears `twitch_unsupported`, since an explicit save is the streamer opting back
 * in and deserves another attempt (e.g. after recreating the reward via the bot).
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
       (streamer_id, twitch_reward_id, enabled, base_cost, cooldown_seconds, max_multiplier, curve, round_to_nearest, demand_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       enabled=new_row.enabled, base_cost=new_row.base_cost, cooldown_seconds=new_row.cooldown_seconds,
       max_multiplier=new_row.max_multiplier, curve=new_row.curve, round_to_nearest=new_row.round_to_nearest,
       twitch_unsupported=0`,
    [
      streamerId, twitchRewardId,
      input.enabled ? 1 : 0, input.base_cost, input.cooldown_seconds, input.max_multiplier, input.curve,
      input.round_to_nearest, Date.now(),
    ],
  );
}

/**
 * Marks a reward as permanently unsupported by Twitch (403 on cost update — created outside
 * this app) and disables it, so the decay scheduler and redemption hook stop retrying.
 *
 * @param streamerId - DB row ID of the owning streamer.
 * @param twitchRewardId - Twitch reward UUID.
 */
export async function markPricingUnsupported(streamerId: number, twitchRewardId: string): Promise<void> {
  await getPool().execute(
    `UPDATE reward_pricing SET enabled = 0, twitch_unsupported = 1 WHERE streamer_id = ? AND twitch_reward_id = ?`,
    [streamerId, twitchRewardId],
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
 * Updates an existing pricing config's `cooldown_seconds` to mirror the reward's current
 * effective Twitch cooldown (its `global_cooldown_seconds` when enabled, otherwise the
 * fallback default) — keeps the two in sync when the reward is edited after pricing was
 * first configured. No-ops (0 rows affected) if no pricing config exists for this reward.
 *
 * @param streamerId - DB row ID of the owning streamer.
 * @param twitchRewardId - Twitch reward UUID.
 * @param cooldownSeconds - The reward's current effective cooldown, in seconds.
 */
export async function updatePricingCooldownForReward(streamerId: number, twitchRewardId: string, cooldownSeconds: number): Promise<void> {
  await getPool().execute(
    `UPDATE reward_pricing SET cooldown_seconds = ? WHERE streamer_id = ? AND twitch_reward_id = ?`,
    [cooldownSeconds, streamerId, twitchRewardId],
  );
}

/**
 * Read a streamer's dynamic-pricing settings (decay half-life and time-to-max-demand
 * multiplier). Falls back to hardcoded defaults (without throwing) if the streamer has no
 * settings row yet, e.g. before they've ever saved this form.
 *
 * @param streamerId - DB row ID of the streamer.
 */
export async function getPricingSettingsForStreamer(streamerId: number): Promise<StreamerPricingSettings> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT half_life_seconds, time_to_max_multiplier FROM reward_pricing_settings WHERE streamer_id = ?`,
    [streamerId],
  );
  if (rows.length === 0) return { ...DEFAULT_STREAMER_PRICING_SETTINGS };
  return {
    half_life_seconds: Number(rows[0].half_life_seconds),
    time_to_max_multiplier: Number(rows[0].time_to_max_multiplier),
  };
}

/**
 * Upsert a streamer's dynamic-pricing settings (decay half-life and time-to-max-demand multiplier).
 *
 * @param streamerId - DB row ID of the streamer.
 * @param settings - The new half-life/time-to-max settings.
 */
export async function savePricingSettingsForStreamer(streamerId: number, settings: StreamerPricingSettings): Promise<void> {
  await getPool().execute(
    `INSERT INTO reward_pricing_settings (streamer_id, half_life_seconds, time_to_max_multiplier)
     VALUES (?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       half_life_seconds=new_row.half_life_seconds, time_to_max_multiplier=new_row.time_to_max_multiplier`,
    [streamerId, settings.half_life_seconds, settings.time_to_max_multiplier],
  );
}
