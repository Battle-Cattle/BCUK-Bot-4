// `advanced_command_usage`: one row per advanced command use. It's the streamer's usage log, the
// count behind per-stream caps and escalating prices, and the refund ledger for companion-app
// acknowledgements (a pending row is resolved exactly once, by a conditional update).
import mysql from 'mysql2/promise';
import { getPool, withTransactionOrNotFound } from './pool';
import { adjustBalanceOnConn } from './loyaltyPoints';

export type AdvancedCommandUsageSource = 'chat' | 'streamdeck';
export type AdvancedCommandUsageStatus = 'pending' | 'succeeded' | 'refunded' | 'no_ack_needed';
export type AdvancedCommandRefundReason = 'no_companion' | 'companion_error' | 'no_ack' | 'restart';

/** A new usage row, as recorded when a command fires. */
export interface NewAdvancedCommandUsage {
  eventId: string;
  commandId: number;
  streamerId: number;
  commandName: string;
  source: AdvancedCommandUsageSource;
  twitchUsername: string | null;
  pointsSpent: number;
  streamStartedAt: Date | null;
  status: 'pending' | 'no_ack_needed';
}

/** A usage row as shown in the streamer's usage log. */
export interface AdvancedCommandUsageEntry {
  eventId: string;
  commandName: string;
  source: AdvancedCommandUsageSource;
  twitchUsername: string | null;
  pointsSpent: number;
  status: AdvancedCommandUsageStatus;
  refundReason: string | null;
  errorMessage: string | null;
  triggeredAt: Date;
}

/** What a resolved pending row needs to refund the viewer (if it was refunded). */
export interface ResolvedAdvancedCommandUsage {
  streamerId: number;
  commandName: string;
  twitchUsername: string | null;
  pointsSpent: number;
}

/** Which uses count towards a per-stream cap or price: one live stream, or a rolling offline window. */
export type AdvancedCommandUsageWindow = { streamStartedAt: Date } | { offlineSince: Date };

/** Longest error text stored from a companion app's failed acknowledgement. */
const MAX_ERROR_MESSAGE_LENGTH = 255;

/**
 * Records a command use.
 * @param usage - The use to record.
 * @returns Resolves once the row is inserted.
 */
export async function recordAdvancedCommandUsage(usage: NewAdvancedCommandUsage): Promise<void> {
  await getPool().execute(
    `INSERT INTO advanced_command_usage
       (event_id, command_id, streamer_id, command_name, source, twitch_username, points_spent, stream_started_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      usage.eventId, usage.commandId, usage.streamerId, usage.commandName, usage.source,
      usage.twitchUsername, usage.pointsSpent, usage.streamStartedAt, usage.status,
    ],
  );
}

/**
 * Counts a command's chat uses in a window, leaving out refunded ones. A live stream's window is
 * every use stamped with that stream's start; offline, it's uses with no stream since `offlineSince`.
 * @param commandId - The command's id.
 * @param window - The stream (or offline window) to count in.
 * @param twitchUsername - Count only this viewer's uses, or omit for everyone's.
 * @returns The number of uses.
 */
export async function countAdvancedCommandUses(
  commandId: number,
  window: AdvancedCommandUsageWindow,
  twitchUsername?: string,
): Promise<number> {
  let sql = `SELECT COUNT(*) AS uses FROM advanced_command_usage
             WHERE command_id = ? AND source = 'chat' AND status <> 'refunded'`;
  const params: Array<number | string | Date> = [commandId];
  if ('streamStartedAt' in window) {
    sql += ' AND stream_started_at = ?';
    params.push(window.streamStartedAt);
  } else {
    sql += ' AND stream_started_at IS NULL AND triggered_at >= ?';
    params.push(window.offlineSince);
  }
  if (twitchUsername !== undefined) {
    sql += ' AND twitch_username = ?';
    params.push(twitchUsername);
  }
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(sql, params);
  // COUNT(*) is a BIGINT and can come back as a string (bigNumberStrings); it counts one command's
  // uses in one stream, nowhere near Number.MAX_SAFE_INTEGER, so parsing it is safe.
  return Number(rows[0]?.uses ?? 0);
}

/**
 * Moves a pending use to `succeeded` or `refunded`. The update only matches a `pending` row, so a
 * late acknowledgement and a timeout (or two acknowledgements) can't both resolve the same use.
 * A refund credits the viewer's points in the same transaction, so a use is never marked
 * refunded without the points coming back: if the credit fails, the row stays `pending` and a
 * later timeout or the startup sweep retries it.
 * @param eventId - The use's event id.
 * @param outcome - The new status, plus the refund reason and the companion app's error text.
 * @returns The resolved row's details, or null if it wasn't pending (already resolved, or unknown).
 */
export async function resolveAdvancedCommandUsage(
  eventId: string,
  outcome: { status: 'succeeded' | 'refunded'; refundReason?: AdvancedCommandRefundReason; errorMessage?: string | null },
): Promise<ResolvedAdvancedCommandUsage | null> {
  return withTransactionOrNotFound(async (conn, notFound) => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT streamer_id, command_name, twitch_username, points_spent FROM advanced_command_usage
       WHERE event_id = ? AND status = 'pending' FOR UPDATE`,
      [eventId],
    );
    const row = rows[0];
    if (!row) return notFound();
    await conn.execute(
      `UPDATE advanced_command_usage
       SET status = ?, refund_reason = ?, error_message = ?, resolved_at = CURRENT_TIMESTAMP
       WHERE event_id = ?`,
      [outcome.status, outcome.refundReason ?? null, outcome.errorMessage?.slice(0, MAX_ERROR_MESSAGE_LENGTH) ?? null, eventId],
    );
    if (outcome.status === 'refunded' && row.points_spent > 0 && row.twitch_username) {
      await adjustBalanceOnConn(conn, row.streamer_id, row.twitch_username, row.points_spent);
    }
    return {
      streamerId: row.streamer_id,
      commandName: row.command_name,
      twitchUsername: row.twitch_username ?? null,
      pointsSpent: row.points_spent,
    };
  });
}

/**
 * Looks up which streamer a use belongs to, so the acknowledgement route can refuse a companion
 * app acknowledging another streamer's event.
 * @param eventId - The use's event id.
 * @returns The owning `streamer.id`, or null if there's no such use.
 */
export async function getAdvancedCommandUsageStreamerId(eventId: string): Promise<number | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT streamer_id FROM advanced_command_usage WHERE event_id = ?',
    [eventId],
  );
  return rows[0]?.streamer_id ?? null;
}

/**
 * Lists the event ids of every use still waiting for an acknowledgement. Called once at startup:
 * the acknowledgement timers live in memory, so anything pending then has lost its timer.
 * @returns The pending event ids.
 */
export async function listPendingAdvancedCommandUsage(): Promise<string[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    "SELECT event_id FROM advanced_command_usage WHERE status = 'pending' ORDER BY id",
  );
  return rows.map((r) => r.event_id as string);
}

/**
 * Returns a streamer's most recent command uses, newest first, for their usage log.
 * @param streamerId - The streamer's `streamer.id`.
 * @param limit - Maximum number of rows.
 * @returns The uses.
 */
export async function listRecentAdvancedCommandUsage(streamerId: number, limit: number): Promise<AdvancedCommandUsageEntry[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT event_id, command_name, source, twitch_username, points_spent, status, refund_reason, error_message, triggered_at
     FROM advanced_command_usage WHERE streamer_id = ? ORDER BY id DESC LIMIT ?`,
    [streamerId, limit],
  );
  return rows.map((r) => ({
    eventId: r.event_id,
    commandName: r.command_name,
    source: r.source,
    twitchUsername: r.twitch_username ?? null,
    pointsSpent: r.points_spent,
    status: r.status,
    refundReason: r.refund_reason ?? null,
    errorMessage: r.error_message ?? null,
    triggeredAt: r.triggered_at,
  }));
}
