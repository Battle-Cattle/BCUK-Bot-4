import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { fromBit, affectedOrExists } from './utils';

/** A per-streamer, Twitch-only auto-posted timer command. */
export interface DbTimerCommand {
  id: number;
  streamer_id: number;
  name: string;
  message: string;
  interval_seconds: number;
  min_messages: number;
  require_live: boolean;
  enabled: boolean;
}

/** Fields a streamer can edit for one timer via the admin UI. */
export interface TimerCommandInput {
  name: string;
  message: string;
  intervalSeconds: number;
  minMessages: number;
  requireLive: boolean;
  enabled: boolean;
}

/** One enabled timer joined with its owning streamer's Twitch channel, for the scheduler's per-tick read. */
export interface TimerCommandForScheduler {
  id: number;
  channel: string;
  message: string;
  interval_seconds: number;
  min_messages: number;
  require_live: boolean;
}

/** Thrown when a timer lookup/mutation scoped to a streamer matches no row — either the id doesn't exist or belongs to a different streamer. */
export class TimerCommandNotFoundError extends Error {
  constructor(id: number) {
    super(`Timer command not found: ${id}`);
    this.name = 'TimerCommandNotFoundError';
  }
}

function mapRow(r: mysql.RowDataPacket): DbTimerCommand {
  return {
    id: r.id,
    streamer_id: r.streamer_id,
    name: r.name,
    message: r.message,
    interval_seconds: r.interval_seconds,
    min_messages: r.min_messages,
    require_live: fromBit(r.require_live),
    enabled: fromBit(r.enabled),
  };
}

const TIMER_COMMAND_SELECT = `
  id, streamer_id, name, message, interval_seconds, min_messages, require_live, enabled`;

/** Whether a timer command exists for `id` scoped to `streamerId` — same ownership scope as the UPDATE statements below. */
async function timerCommandExists(id: number, streamerId: number): Promise<boolean> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT 1 FROM timer_command WHERE id = ? AND streamer_id = ? LIMIT 1`,
    [id, streamerId],
  );
  return rows.length > 0;
}

/**
 * Lists every timer command belonging to a streamer, for the self-service admin page.
 * @param streamerId - DB row ID of the streamer.
 */
export async function getTimerCommandsForStreamer(streamerId: number): Promise<DbTimerCommand[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${TIMER_COMMAND_SELECT} FROM timer_command WHERE streamer_id = ? ORDER BY id`,
    [streamerId],
  );
  return rows.map(mapRow);
}

/**
 * Creates a new timer command for a streamer.
 * @param streamerId - DB row ID of the owning streamer.
 * @param input - The timer's fields.
 * @returns The new timer's primary key.
 */
export async function addTimerCommand(streamerId: number, input: TimerCommandInput): Promise<number> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `INSERT INTO timer_command (streamer_id, name, message, interval_seconds, min_messages, require_live, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      streamerId, input.name, input.message, input.intervalSeconds, input.minMessages,
      input.requireLive ? 1 : 0, input.enabled ? 1 : 0,
    ],
  );
  return result.insertId;
}

/**
 * Updates an existing timer command, scoped to the owning streamer so one streamer can never
 * edit another's timer by guessing an id.
 * @param id - Primary key of the `timer_command` row.
 * @param streamerId - DB row ID of the owning streamer.
 * @param input - The timer's new fields.
 * @throws {TimerCommandNotFoundError} If no row matches both `id` and `streamerId`.
 */
export async function updateTimerCommand(id: number, streamerId: number, input: TimerCommandInput): Promise<void> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE timer_command
     SET name = ?, message = ?, interval_seconds = ?, min_messages = ?, require_live = ?, enabled = ?
     WHERE id = ? AND streamer_id = ?`,
    [
      input.name, input.message, input.intervalSeconds, input.minMessages,
      input.requireLive ? 1 : 0, input.enabled ? 1 : 0, id, streamerId,
    ],
  );
  // affectedRows is 0 both when no row matched and when the row matched but every value was
  // already equal (MySQL's default UPDATE semantics count only rows actually changed) — a
  // resubmitted, unchanged edit must not be mistaken for a missing/foreign timer.
  if (!(await affectedOrExists(result.affectedRows, () => timerCommandExists(id, streamerId)))) {
    throw new TimerCommandNotFoundError(id);
  }
}

/**
 * Deletes a timer command, scoped to the owning streamer. No-ops if the id doesn't exist or
 * belongs to a different streamer.
 * @param id - Primary key of the `timer_command` row.
 * @param streamerId - DB row ID of the owning streamer.
 */
export async function removeTimerCommand(id: number, streamerId: number): Promise<void> {
  await getPool().execute(
    `DELETE FROM timer_command WHERE id = ? AND streamer_id = ?`,
    [id, streamerId],
  );
}

/**
 * Toggles a timer command's `enabled` flag, scoped to the owning streamer.
 * @param id - Primary key of the `timer_command` row.
 * @param streamerId - DB row ID of the owning streamer.
 * @param enabled - The new enabled state.
 * @throws {TimerCommandNotFoundError} If no row matches both `id` and `streamerId`.
 */
export async function setTimerCommandEnabled(id: number, streamerId: number, enabled: boolean): Promise<void> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE timer_command SET enabled = ? WHERE id = ? AND streamer_id = ?`,
    [enabled ? 1 : 0, id, streamerId],
  );
  // See updateTimerCommand: affectedRows is 0 both for a missing row and a no-op toggle
  // (already in the requested state), so a re-click of an already-toggled timer must not
  // be mistaken for a missing/foreign one.
  if (!(await affectedOrExists(result.affectedRows, () => timerCommandExists(id, streamerId)))) {
    throw new TimerCommandNotFoundError(id);
  }
}

/**
 * Lists every enabled timer command across all streamers, joined with its owning streamer's
 * linked Twitch channel name. Streamers with no linked Twitch name are excluded — there's no
 * channel to post to. Queried fresh every scheduler tick rather than cached, mirroring
 * `getAllEnabledPricingRows()`.
 */
export async function getAllEnabledTimerCommandsWithChannel(): Promise<TimerCommandForScheduler[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT tc.id, u.twitch_name AS channel, tc.message, tc.interval_seconds, tc.min_messages, tc.require_live
     FROM timer_command tc
     JOIN streamer s ON s.id = tc.streamer_id
     JOIN \`user\` u ON u.discord_id = s.discord_id
     WHERE tc.enabled = 1 AND u.twitch_name IS NOT NULL
     ORDER BY tc.streamer_id`,
  );
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    message: r.message,
    interval_seconds: r.interval_seconds,
    min_messages: r.min_messages,
    require_live: fromBit(r.require_live),
  }));
}
