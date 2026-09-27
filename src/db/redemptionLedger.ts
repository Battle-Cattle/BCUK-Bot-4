import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { fromBit } from './utils';

/**
 * How far a channel-point redemption has got through `handleRedemption`'s required effects, as
 * recorded durably in `redemption_handled`. Lets a retry — including a reconciliation replay long
 * after the in-memory dedup cache has forgotten the redemption — skip effects that already ran.
 */
export interface RedemptionProgress {
  /** The redemption's "Recent Events" dashboard row was recorded. */
  dashboardRecorded: boolean;
  /** The redemption's dynamic-pricing increment was applied. */
  pricingApplied: boolean;
  /** Every required effect succeeded; the redemption must not be processed again. */
  handled: boolean;
}

/** One effect {@link markRedemptionEffect} can record for a redemption. */
export type RedemptionEffect = 'dashboard_recorded' | 'pricing_applied' | 'handled';

/**
 * Fixed column/value SQL per effect. Interpolated into the upsert below, so it must only ever come
 * from this map, never from a caller-supplied string.
 */
const EFFECT_COLUMNS: Record<RedemptionEffect, { column: string; value: string }> = {
  dashboard_recorded: { column: 'dashboard_recorded', value: '1' },
  pricing_applied: { column: 'pricing_applied', value: '1' },
  handled: { column: 'handled_at', value: 'NOW()' },
};

/**
 * Looks up a redemption's recorded progress.
 * @param redemptionId - Twitch's own redemption id.
 * @returns Its progress, or null if nothing has been recorded for it (never seen, or pruned).
 */
export async function getRedemptionProgress(redemptionId: string): Promise<RedemptionProgress | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT dashboard_recorded, pricing_applied, handled_at FROM redemption_handled WHERE redemption_id = ?',
    [redemptionId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    dashboardRecorded: fromBit(row.dashboard_recorded),
    pricingApplied: fromBit(row.pricing_applied),
    handled: row.handled_at != null,
  };
}

/**
 * Records that one effect of a redemption has run, creating the redemption's row on first use.
 * Idempotent: recording the same effect again is a no-op apart from `handled_at`'s timestamp.
 * @param redemptionId - Twitch's own redemption id.
 * @param streamerId - DB row id of the streamer the redemption belongs to.
 * @param effect - Which effect completed; `'handled'` marks the whole redemption done.
 * @returns Resolves once the row is written.
 */
export async function markRedemptionEffect(redemptionId: string, streamerId: number, effect: RedemptionEffect): Promise<void> {
  const { column, value } = EFFECT_COLUMNS[effect];
  await getPool().execute(
    `INSERT INTO redemption_handled (redemption_id, streamer_id, ${column}) VALUES (?, ?, ${value}) AS new_row
     ON DUPLICATE KEY UPDATE ${column} = new_row.${column}`,
    [redemptionId, streamerId],
  );
}

/**
 * Deletes ledger rows created more than `retentionMs` ago. The retention must outlast the longest
 * window reconciliation can replay (see `MAX_CURSOR_LAG_MS`), or a replay could miss a row that
 * was already pruned and process its redemption again.
 * @param retentionMs - Age (ms) beyond which rows are deleted.
 * @returns How many rows were deleted.
 */
export async function pruneRedemptionLedger(retentionMs: number): Promise<number> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    'DELETE FROM redemption_handled WHERE created_at < (NOW() - INTERVAL ? SECOND)',
    [Math.ceil(retentionMs / 1000)],
  );
  return result.affectedRows;
}
