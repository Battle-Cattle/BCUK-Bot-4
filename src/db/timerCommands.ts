import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { fromBit, affectedOrExists, rowExists } from './utils';
import { AccessLevel } from './users';
import type { AccessLevelValue } from './users';

/** A timer command row from the database. */
export interface DbTimerCommand {
  id: number;
  name: string;
  message: string;
  interval_seconds: number;
  min_messages: number;
  require_live: boolean;
  enabled: boolean;
}

/** A user assigned to a timer command (may be orphaned if their account no longer exists). */
export interface DbTimerCommandAssignedUser {
  discord_id: string;
  discord_name: string | null;
  twitch_name: string | null;
  access_level: AccessLevelValue;
  is_orphaned_user: boolean;
}

/** A timer command with its full list of assigned users. */
export interface DbTimerCommandWithAssignments extends DbTimerCommand {
  assigned_users: DbTimerCommandAssignedUser[];
}

/** Fields a manager can edit for one timer via the admin UI. */
export interface TimerCommandInput {
  name: string;
  message: string;
  intervalSeconds: number;
  minMessages: number;
  requireLive: boolean;
  enabled: boolean;
}

/** One enabled timer joined with one of its assigned users' Twitch channel, for the scheduler's per-tick read. A timer assigned to several channels appears once per channel, each firing independently. */
export interface TimerCommandForScheduler {
  id: number;
  channel: string;
  message: string;
  interval_seconds: number;
  min_messages: number;
  require_live: boolean;
}

/** Thrown when a timer lookup/mutation matches no row. */
export class TimerCommandNotFoundError extends Error {
  constructor(id: number) {
    super(`Timer command not found: ${id}`);
    this.name = 'TimerCommandNotFoundError';
  }
}

function mapRow(r: mysql.RowDataPacket): DbTimerCommand {
  return {
    id: r.id,
    name: r.name,
    message: r.message,
    interval_seconds: r.interval_seconds,
    min_messages: r.min_messages,
    require_live: fromBit(r.require_live),
    enabled: fromBit(r.enabled),
  };
}

/** Whether a timer command exists for `id`. */
async function timerCommandExists(id: number): Promise<boolean> {
  return rowExists(getPool(), 'timer_command', 'id', id);
}

/** Return all timer commands, each with its full list of assigned users, for the manager admin page. */
export async function getAllTimerCommandsWithAssignments(): Promise<DbTimerCommandWithAssignments[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT tc.id, tc.name, tc.message, tc.interval_seconds, tc.min_messages, tc.require_live, tc.enabled,
            tcs.discord_id AS assigned_discord_id,
            u.discord_id AS user_discord_id,
            u.discord_name, u.twitch_name, u.access_level
     FROM timer_command tc
     LEFT JOIN timer_command_streamer tcs ON tc.id = tcs.timer_id
     LEFT JOIN \`user\` u ON tcs.discord_id = u.discord_id
     ORDER BY tc.name, u.discord_name, tcs.discord_id`,
  );

  const timerMap = new Map<number, DbTimerCommandWithAssignments>();

  for (const row of rows) {
    if (!timerMap.has(row.id)) {
      timerMap.set(row.id, {
        ...mapRow(row),
        assigned_users: [],
      });
    }

    if (row.assigned_discord_id !== null && row.assigned_discord_id !== undefined) {
      timerMap.get(row.id)!.assigned_users.push({
        discord_id: String(row.assigned_discord_id),
        discord_name: row.discord_name ?? null,
        twitch_name: row.twitch_name ?? null,
        access_level: row.access_level ?? AccessLevel.USER,
        is_orphaned_user: row.user_discord_id === null || row.user_discord_id === undefined,
      });
    }
  }

  return Array.from(timerMap.values());
}

/**
 * Creates a new timer command.
 * @param input - The timer's fields.
 * @returns The new timer's primary key.
 */
export async function addTimerCommand(input: TimerCommandInput): Promise<number> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `INSERT INTO timer_command (name, message, interval_seconds, min_messages, require_live, enabled)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.name, input.message, input.intervalSeconds, input.minMessages,
      input.requireLive ? 1 : 0, input.enabled ? 1 : 0,
    ],
  );
  return result.insertId;
}

/**
 * Updates an existing timer command's fields.
 * @param id - Primary key of the `timer_command` row.
 * @param input - The timer's new fields.
 * @throws {TimerCommandNotFoundError} If no row matches `id`.
 */
export async function updateTimerCommand(id: number, input: TimerCommandInput): Promise<void> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE timer_command
     SET name = ?, message = ?, interval_seconds = ?, min_messages = ?, require_live = ?, enabled = ?
     WHERE id = ?`,
    [
      input.name, input.message, input.intervalSeconds, input.minMessages,
      input.requireLive ? 1 : 0, input.enabled ? 1 : 0, id,
    ],
  );
  // affectedRows is 0 both when no row matched and when the row matched but every value was
  // already equal (MySQL's default UPDATE semantics count only rows actually changed) — a
  // resubmitted, unchanged edit must not be mistaken for a missing timer.
  if (!(await affectedOrExists(result.affectedRows, () => timerCommandExists(id)))) {
    throw new TimerCommandNotFoundError(id);
  }
}

/**
 * Deletes a timer command and all its streamer assignments (cascaded by the FK).
 * @param id - Primary key of the `timer_command` row.
 */
export async function removeTimerCommand(id: number): Promise<void> {
  await getPool().execute(`DELETE FROM timer_command WHERE id = ?`, [id]);
}

/**
 * Toggles a timer command's `enabled` flag, for a one-click enable/disable control in the
 * timer list without opening the full edit form.
 * @param id - Primary key of the `timer_command` row.
 * @param enabled - The new enabled state.
 * @throws {TimerCommandNotFoundError} If no row matches `id`.
 */
export async function setTimerCommandEnabled(id: number, enabled: boolean): Promise<void> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE timer_command SET enabled = ? WHERE id = ?`,
    [enabled ? 1 : 0, id],
  );
  // See updateTimerCommand: affectedRows is 0 both for a missing row and a no-op toggle
  // (already in the requested state), so a re-click of an already-toggled timer must not
  // be mistaken for a missing one.
  if (!(await affectedOrExists(result.affectedRows, () => timerCommandExists(id)))) {
    throw new TimerCommandNotFoundError(id);
  }
}

/**
 * Assigns a Twitch-linked Discord user to a timer command's channel list.
 * @param timerId - ID of the timer to assign the user to.
 * @param discordId - Discord snowflake of the user to assign.
 */
export async function assignUserToTimer(timerId: number, discordId: string): Promise<void> {
  await getPool().execute(
    `INSERT INTO timer_command_streamer (timer_id, discord_id)
     VALUES (?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       timer_id = new_row.timer_id`,
    [timerId, discordId],
  );
}

/**
 * Assigns multiple Discord users to a timer command's channel list in one statement.
 * A no-op (no query issued) when `discordIds` is empty.
 * @param timerId - ID of the timer to assign the users to.
 * @param discordIds - Discord snowflakes of the users to assign.
 */
export async function assignUsersToTimer(timerId: number, discordIds: string[]): Promise<void> {
  if (discordIds.length === 0) return;

  const placeholders = discordIds.map(() => '(?, ?)').join(', ');
  const params = discordIds.flatMap((discordId) => [timerId, discordId]);

  await getPool().execute(
    `INSERT INTO timer_command_streamer (timer_id, discord_id)
     VALUES ${placeholders} AS new_row
     ON DUPLICATE KEY UPDATE
       timer_id = new_row.timer_id`,
    params,
  );
}

/**
 * Removes a Discord user's assignment from a timer command.
 * @param timerId - ID of the timer to remove the assignment from.
 * @param discordId - Discord snowflake of the user to unassign.
 */
export async function unassignUserFromTimer(timerId: number, discordId: string): Promise<void> {
  await getPool().execute(
    `DELETE FROM timer_command_streamer WHERE timer_id = ? AND discord_id = ?`,
    [timerId, discordId],
  );
}

/**
 * Lists every enabled timer command joined with each of its assigned users' linked Twitch
 * channel, for the scheduler's per-tick read. A timer assigned to several streamers appears
 * once per assigned channel, each firing independently — assignees with no linked Twitch name
 * are excluded, since there's no channel to post to. Queried fresh every scheduler tick rather
 * than cached, mirroring `getAllEnabledPricingRows()`.
 */
export async function getAllEnabledTimerCommandsWithChannel(): Promise<TimerCommandForScheduler[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT tc.id, u.twitch_name AS channel, tc.message, tc.interval_seconds, tc.min_messages, tc.require_live
     FROM timer_command tc
     JOIN timer_command_streamer tcs ON tcs.timer_id = tc.id
     JOIN \`user\` u ON u.discord_id = tcs.discord_id
     WHERE tc.enabled = 1 AND u.twitch_name IS NOT NULL
     ORDER BY tc.id, u.discord_id`,
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
