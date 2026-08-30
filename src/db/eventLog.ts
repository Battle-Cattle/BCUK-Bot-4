import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { isMysqlDuplicateEntryError } from './commandStringUtils';

/** Kind of streamer activity recorded in `streamer_event_log`. */
export type StreamerEventType = 'follow' | 'sub' | 'resub' | 'giftsub' | 'raid' | 'redemption';

/** One recorded activity event for a streamer's dashboard "Recent Events" feed. */
export interface StreamerEvent {
  eventType: StreamerEventType;
  displayName: string;
  detail: string | null;
  occurredAt: Date;
}

// Dashboard only ever displays the latest ~20 events, so retaining this many per streamer
// keeps the table bounded regardless of how bursty follows/raids/redemptions get.
const EVENTS_RETAINED_PER_STREAMER = 200;

// Running the DELETE...ORDER BY...LIMIT prune query after every single insert doubles the
// write cost of recording an event, even though the table is nowhere near its cap on most
// inserts. Instead, prune only once every this-many inserts per streamer — a soft cap that
// lets the table temporarily overshoot EVENTS_RETAINED_PER_STREAMER by at most this much
// between prunes, which the dashboard's ~20-row "Recent Events" feed never notices.
const PRUNE_EVERY_N_INSERTS = 10;

/** In-memory count of inserts since the last prune, per streamer. Reset on process restart —
 * worst case that just delays the next prune by up to {@link PRUNE_EVERY_N_INSERTS} inserts. */
const insertsSincePrune = new Map<number, number>();

/**
 * Records a streamer activity event, then — only once every {@link PRUNE_EVERY_N_INSERTS}
 * inserts for that streamer — prunes that streamer's rows down to the most recent
 * {@link EVENTS_RETAINED_PER_STREAMER}, so the table stays bounded (with a small, bounded
 * overshoot between prunes) without paying a second round-trip on every insert. The prune, when
 * it runs, always runs after the insert completes (not concurrently) so it sees the
 * just-inserted row — two connections racing via `Promise.all` could otherwise let the prune's
 * snapshot miss the new row.
 *
 * When `redemptionId` is given and collides with an existing row's `redemption_id` (the
 * `streamer_event_log` unique index), the insert is treated as already-done and silently
 * skipped (no error, no prune) rather than creating a duplicate row — this is what makes a
 * retried redemption (see `handleRedemption`'s dedup pending/handled lifecycle) safe to record
 * again after an earlier attempt already succeeded here but failed on a later required effect.
 * Any other insert failure (including a genuine duplicate on an unrelated constraint) still
 * propagates normally.
 *
 * @param streamerId - Primary key of the `streamer` row this event belongs to.
 * @param eventType - Kind of activity that occurred.
 * @param displayName - The acting Twitch viewer's display name (follower, raider, redeemer, etc.).
 * @param detail - Short additional context (e.g. raid viewer count, redeemed reward name and any
 *   text the viewer entered), or null if there's none.
 * @param redemptionId - Twitch's own redemption id, for `eventType: 'redemption'` only; omit or
 *   pass null for every other event type.
 * @returns True if this call actually inserted a new row; false if it collided with an
 *   already-recorded `redemptionId` and was skipped. Callers that also push a live update (e.g.
 *   the dashboard SSE feed) should only do so when this returns true, so a retry doesn't
 *   re-deliver a live event for a redemption that was already recorded on an earlier attempt.
 */
export async function recordStreamerEvent(
  streamerId: number,
  eventType: StreamerEventType,
  displayName: string,
  detail: string | null,
  redemptionId?: string | null,
): Promise<boolean> {
  try {
    await getPool().execute(
      `INSERT INTO streamer_event_log (streamer_id, event_type, display_name, detail, redemption_id) VALUES (?, ?, ?, ?, ?)`,
      [streamerId, eventType, displayName, detail, redemptionId ?? null],
    );
  } catch (err) {
    if (redemptionId && isMysqlDuplicateEntryError(err)) return false;
    throw err;
  }

  const count = (insertsSincePrune.get(streamerId) ?? 0) + 1;
  if (count < PRUNE_EVERY_N_INSERTS) {
    insertsSincePrune.set(streamerId, count);
    return true;
  }
  insertsSincePrune.set(streamerId, 0);

  // mysql2's prepared statements (execute()) can't bind LIMIT as a placeholder, so the
  // retention count — a fixed internal constant, never user input — is inlined directly.
  await getPool().execute(
    `DELETE FROM streamer_event_log WHERE streamer_id = ? AND id NOT IN (
       SELECT id FROM (
         SELECT id FROM streamer_event_log WHERE streamer_id = ?
         ORDER BY occurred_at DESC, id DESC LIMIT ${EVENTS_RETAINED_PER_STREAMER}
       ) AS keep
     )`,
    [streamerId, streamerId],
  );
  return true;
}

/**
 * Returns a streamer's most recent activity events, newest first, for the dashboard's
 * "Recent Events" feed.
 *
 * @param streamerId - Primary key of the `streamer` row.
 * @param limit - Maximum number of events to return.
 */
export async function getRecentStreamerEvents(streamerId: number, limit: number): Promise<StreamerEvent[]> {
  // mysql2's prepared statements (execute()) can't bind LIMIT as a placeholder, so the
  // caller-supplied limit is validated as a plain non-negative integer, then inlined directly.
  if (!Number.isInteger(limit) || limit < 0) throw new Error(`Invalid limit: ${limit}`);
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT event_type, display_name, detail, occurred_at FROM streamer_event_log
     WHERE streamer_id = ?
     ORDER BY occurred_at DESC, id DESC
     LIMIT ${limit}`,
    [streamerId],
  );
  return rows.map((r) => ({
    eventType: r.event_type,
    displayName: r.display_name,
    detail: r.detail,
    occurredAt: r.occurred_at,
  }));
}

/** Test-only: clears the in-memory per-streamer prune-cadence counters so each test starts from a clean slate. */
export function __resetEventLogPruneCountersForTests(): void {
  insertsSincePrune.clear();
}
