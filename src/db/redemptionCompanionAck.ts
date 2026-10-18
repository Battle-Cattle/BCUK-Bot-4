// Companion confirmation for channel-point rewards: `reward_companion_confirmation` says which
// rewards wait for the streamer's companion app to confirm, and `redemption_companion_ack` is the
// per-redemption ledger. A pending row is resolved exactly once, by a conditional update, so a
// late acknowledgement and a timeout can't both act on the same redemption.
import mysql from 'mysql2/promise';
import { getPool } from './pool';

export type RedemptionAckStatus = 'pending' | 'fulfilled' | 'refunded' | 'refund_failed';
export type RedemptionRefundReason = 'no_companion' | 'companion_error' | 'no_ack' | 'restart';

/** A redemption waiting for its companion confirmation, as recorded by {@link recordPendingRedemptionAck}. */
export interface PendingRedemptionAck {
  redemptionId: string;
  streamerId: number;
  twitchRewardId: string;
  rewardTitle: string;
  userLogin: string;
  /** When the redemption was handled (epoch ms) — the dynamic-pricing revert decays its increment from here. */
  redeemedAtMs: number;
}

/** Longest error text stored from a companion app's failed acknowledgement. */
const MAX_ERROR_MESSAGE_LENGTH = 255;

/**
 * Lists the rewards of a streamer that require companion confirmation.
 * @param streamerId - The streamer's `streamer.id`.
 * @returns Their Twitch reward ids.
 */
export async function listCompanionConfirmationRewardIds(streamerId: number): Promise<Set<string>> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT twitch_reward_id FROM reward_companion_confirmation WHERE streamer_id = ?',
    [streamerId],
  );
  return new Set(rows.map((r) => r.twitch_reward_id as string));
}

/**
 * Whether one reward requires companion confirmation.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchRewardId - Twitch reward UUID.
 * @returns True if it does.
 */
export async function isCompanionConfirmationRequired(streamerId: number, twitchRewardId: string): Promise<boolean> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT 1 FROM reward_companion_confirmation WHERE streamer_id = ? AND twitch_reward_id = ?',
    [streamerId, twitchRewardId],
  );
  return rows.length > 0;
}

/**
 * Turns companion confirmation on or off for a reward. Idempotent either way.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchRewardId - Twitch reward UUID.
 * @param required - True to require confirmation, false to stop requiring it.
 * @returns Resolves once written.
 */
export async function setCompanionConfirmationRequired(streamerId: number, twitchRewardId: string, required: boolean): Promise<void> {
  if (!required) {
    await getPool().execute(
      'DELETE FROM reward_companion_confirmation WHERE streamer_id = ? AND twitch_reward_id = ?',
      [streamerId, twitchRewardId],
    );
    return;
  }
  await getPool().execute(
    `INSERT INTO reward_companion_confirmation (streamer_id, twitch_reward_id) VALUES (?, ?) AS new_row
     ON DUPLICATE KEY UPDATE twitch_reward_id = new_row.twitch_reward_id`,
    [streamerId, twitchRewardId],
  );
}

/**
 * Records a redemption as waiting for companion confirmation. A retry of the same redemption
 * leaves the existing row (and whatever it was resolved to) alone.
 * @param ack - The redemption.
 * @returns True if the redemption is pending (newly recorded, or recorded before and still
 *   unresolved); false if an earlier attempt's row has already been resolved (fulfilled or refunded).
 */
export async function recordPendingRedemptionAck(ack: PendingRedemptionAck): Promise<boolean> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `INSERT INTO redemption_companion_ack
       (redemption_id, streamer_id, twitch_reward_id, reward_title, user_login, redeemed_at_ms)
     VALUES (?, ?, ?, ?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE redemption_id = new_row.redemption_id`,
    [ack.redemptionId, ack.streamerId, ack.twitchRewardId, ack.rewardTitle, ack.userLogin, ack.redeemedAtMs],
  );
  // 1 = inserted. Anything else is a retry hitting the existing row, whose status decides.
  if (result.affectedRows === 1) return true;
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT status FROM redemption_companion_ack WHERE redemption_id = ?',
    [ack.redemptionId],
  );
  return rows[0]?.status === 'pending';
}

/**
 * Moves a pending redemption to `fulfilled`, `refunded` or `refund_failed`. The update only
 * matches a `pending` row, so only one caller ever wins a redemption; the rest get null.
 * @param redemptionId - Twitch's redemption id.
 * @param outcome - The new status, plus the refund reason and the companion app's error text.
 * @returns The redemption, or null if it wasn't pending (already resolved, or unknown).
 */
export async function claimRedemptionAck(
  redemptionId: string,
  outcome: { status: Exclude<RedemptionAckStatus, 'pending'>; refundReason?: RedemptionRefundReason; errorMessage?: string | null },
): Promise<PendingRedemptionAck | null> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE redemption_companion_ack
     SET status = ?, refund_reason = ?, error_message = ?, resolved_at = CURRENT_TIMESTAMP
     WHERE redemption_id = ? AND status = 'pending'`,
    [outcome.status, outcome.refundReason ?? null, outcome.errorMessage?.slice(0, MAX_ERROR_MESSAGE_LENGTH) ?? null, redemptionId],
  );
  if (result.affectedRows === 0) return null;
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT redemption_id, streamer_id, twitch_reward_id, reward_title, user_login, redeemed_at_ms
     FROM redemption_companion_ack WHERE redemption_id = ?`,
    [redemptionId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    redemptionId: row.redemption_id,
    streamerId: row.streamer_id,
    twitchRewardId: row.twitch_reward_id,
    rewardTitle: row.reward_title,
    userLogin: row.user_login,
    // BIGINT epoch ms — safe to coerce, won't exceed MAX_SAFE_INTEGER until year 275760.
    redeemedAtMs: Number(row.redeemed_at_ms),
  };
}

/**
 * Puts a claimed redemption back to `pending`, after the Twitch call that was meant to resolve it
 * failed transiently, so a retry can claim it again.
 * @param redemptionId - Twitch's redemption id.
 * @returns Resolves once written.
 */
export async function releaseRedemptionAck(redemptionId: string): Promise<void> {
  await getPool().execute(
    `UPDATE redemption_companion_ack
     SET status = 'pending', refund_reason = NULL, error_message = NULL, resolved_at = NULL
     WHERE redemption_id = ?`,
    [redemptionId],
  );
}

/**
 * Updates a resolved redemption's status, e.g. `refunded` → `refund_failed` once Twitch has
 * refused the refund for good.
 * @param redemptionId - Twitch's redemption id.
 * @param status - The new status.
 * @param errorMessage - Why, if known.
 * @returns Resolves once written.
 */
export async function updateRedemptionAckStatus(redemptionId: string, status: RedemptionAckStatus, errorMessage: string | null): Promise<void> {
  await getPool().execute(
    'UPDATE redemption_companion_ack SET status = ?, error_message = ? WHERE redemption_id = ?',
    [status, errorMessage?.slice(0, MAX_ERROR_MESSAGE_LENGTH) ?? null, redemptionId],
  );
}

/**
 * Looks up which streamer a redemption belongs to, so the acknowledgement route can refuse a
 * companion app acknowledging another streamer's redemption.
 * @param redemptionId - Twitch's redemption id.
 * @returns The owning `streamer.id`, or null if no confirmation is recorded for it.
 */
export async function getRedemptionAckStreamerId(redemptionId: string): Promise<number | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT streamer_id FROM redemption_companion_ack WHERE redemption_id = ?',
    [redemptionId],
  );
  return rows[0]?.streamer_id ?? null;
}

/**
 * Lists every redemption still waiting for confirmation. Called once at startup: the timers live
 * in memory, so anything pending then has lost its timer.
 * @returns The pending redemption ids.
 */
export async function listPendingRedemptionAcks(): Promise<string[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    "SELECT redemption_id FROM redemption_companion_ack WHERE status = 'pending' ORDER BY created_at",
  );
  return rows.map((r) => r.redemption_id as string);
}

/**
 * Deletes resolved rows older than `retentionMs`. Pending rows are kept whatever their age.
 * @param retentionMs - Age (ms) since resolution beyond which rows are deleted.
 * @returns How many rows were deleted.
 */
export async function pruneResolvedRedemptionAcks(retentionMs: number): Promise<number> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    "DELETE FROM redemption_companion_ack WHERE status <> 'pending' AND resolved_at < (NOW() - INTERVAL ? SECOND)",
    [Math.ceil(retentionMs / 1000)],
  );
  return result.affectedRows;
}
