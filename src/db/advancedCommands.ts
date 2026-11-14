// Per-streamer advanced commands: pure DB layer with no cache knowledge (the lookup cache is
// invalidated by `advancedCommandWrites.ts`, same split as customCommands/customCommandWrites).
// Every read and write is scoped by `streamer_id`: a streamer can only see and change their own.
// A command's effects (params, videos, alert) live in `advancedCommandEffects.ts`.
import mysql, { type PoolConnection } from 'mysql2/promise';
import { getPool, withTransaction, withTransactionOrNotFound } from './pool';
import { buildInClausePlaceholders, isMysqlDuplicateEntryError, fromBit } from './utils';
import { runSerializedCommandWrite } from './commandWriteGuard';
import {
  normalizeAdvancedCommandSettings,
  type AdvancedCommandRole,
  type AdvancedCommandSettings,
} from './advancedCommandValidation';
import { attachEffects, assetFilenames, type AdvancedCommandEffects } from './advancedCommandEffects';

/** An advanced command row with its effects. */
export interface DbAdvancedCommand extends AdvancedCommandSettings, AdvancedCommandEffects {
  id: number;
  streamerId: number;
}

/** Where an enabled, chat-triggerable advanced command fires, for the chat lookup cache. */
export interface AdvancedCommandChatRoute {
  commandId: number;
  streamerId: number;
  triggerString: string;
  twitchName: string;
  /** The streamer's Discord id (BIGINT, as a string) — the companion event stream's key. */
  discordId: string;
}

/**
 * Thrown when a streamer already has an advanced command with the same name or trigger.
 * `field` says which one collided.
 */
export class AdvancedCommandConflictError extends Error {
  readonly field: 'name' | 'trigger';

  constructor(field: 'name' | 'trigger') {
    super(`An advanced command with this ${field} already exists`);
    this.name = 'AdvancedCommandConflictError';
    this.field = field;
  }
}

const COMMAND_COLUMNS = `ac.id, ac.streamer_id, ac.name, ac.trigger_string, ac.is_enabled, ac.response, ac.point_cost,
  ac.price_step, ac.max_cost, ac.global_cooldown_seconds, ac.user_cooldown_seconds, ac.min_role, ac.live_only,
  ac.max_uses_per_stream, ac.max_uses_per_user_per_stream, ac.companion_enabled`;

// ─── Row mapping ──────────────────────────────────────────────────────────────

/**
 * Maps a raw `advanced_command` row to a {@link DbAdvancedCommand} with empty effects.
 * @param row - Row selected from `advanced_command`.
 * @returns The mapped command, with `effects` left empty for the caller to fill.
 */
function mapCommand(row: mysql.RowDataPacket): DbAdvancedCommand {
  return {
    id: row.id,
    streamerId: row.streamer_id,
    name: row.name,
    triggerString: row.trigger_string ?? null,
    isEnabled: fromBit(row.is_enabled),
    response: row.response ?? null,
    pointCost: row.point_cost,
    priceStep: row.price_step,
    maxCost: row.max_cost ?? null,
    globalCooldownSeconds: row.global_cooldown_seconds,
    userCooldownSeconds: row.user_cooldown_seconds,
    minRole: row.min_role as AdvancedCommandRole,
    liveOnly: fromBit(row.live_only),
    maxUsesPerStream: row.max_uses_per_stream ?? null,
    maxUsesPerUserPerStream: row.max_uses_per_user_per_stream ?? null,
    companionEnabled: fromBit(row.companion_enabled),
    params: [],
    videos: [],
    alert: null,
  };
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Lists a streamer's advanced commands with their effects, by name.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @returns The streamer's commands.
 */
export async function listAdvancedCommands(streamerId: number): Promise<DbAdvancedCommand[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${COMMAND_COLUMNS} FROM advanced_command ac WHERE ac.streamer_id = ? ORDER BY ac.name`,
    [streamerId],
  );
  return attachEffects(rows.map(mapCommand));
}

/**
 * Looks up one of a streamer's advanced commands with its effects.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param commandId - The command's id.
 * @returns The command, or null if it doesn't exist or belongs to another streamer.
 */
export async function getAdvancedCommand(streamerId: number, commandId: number): Promise<DbAdvancedCommand | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${COMMAND_COLUMNS} FROM advanced_command ac WHERE ac.streamer_id = ? AND ac.id = ?`,
    [streamerId, commandId],
  );
  const row = rows[0];
  if (!row) return null;
  const [command] = await attachEffects([mapCommand(row)]);
  return command ?? null;
}

/**
 * Lists every enabled advanced command that has a chat trigger, on a channel whose Twitch bot is
 * enabled — the source for the chat lookup cache. The cache holds only these routes; the full
 * command is loaded fresh with {@link getAdvancedCommand} when one fires, so edits, deleted
 * overlay videos and the like never go stale in it.
 * @returns The routes, in ascending command id order.
 */
export async function getAllAdvancedCommandChatRoutes(): Promise<AdvancedCommandChatRoute[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ac.id, ac.streamer_id, ac.trigger_string, u.twitch_name, s.discord_id
     FROM advanced_command ac
     JOIN streamer s ON s.id = ac.streamer_id
     JOIN \`user\` u ON u.discord_id = s.discord_id
     WHERE ac.is_enabled = 1 AND ac.trigger_string IS NOT NULL
       AND u.twitch_name IS NOT NULL AND u.is_twitch_bot_enabled = 1
     ORDER BY ac.id`,
  );
  return rows.map((row) => ({
    commandId: row.id, streamerId: row.streamer_id, triggerString: row.trigger_string, twitchName: row.twitch_name,
    discordId: String(row.discord_id),
  }));
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Runs `write` under the command-namespace guard when the command has a chat trigger (so it can't
 * collide with a built-in, custom command or counter), or in a plain transaction when it doesn't.
 * A duplicate name or trigger for the same streamer becomes an {@link AdvancedCommandConflictError}.
 * @param trigger - The normalised trigger, or null.
 * @param write - The write to run on the guarded connection.
 * @returns What `write` returns.
 */
async function runGuardedWrite<T>(trigger: string | null, write: (conn: PoolConnection) => Promise<T>): Promise<T> {
  try {
    if (trigger === null) return await withTransaction(write);
    return await runSerializedCommandWrite(trigger, undefined, write, {
      includeCustomCommandTable: true, includeCounterTable: true, includeAdvancedCommandTable: false,
    });
  } catch (err) {
    if (isMysqlDuplicateEntryError(err)) {
      const message = (err as Error).message;
      throw new AdvancedCommandConflictError(message.includes('uq_advanced_command_name') ? 'name' : 'trigger');
    }
    throw err;
  }
}

/**
 * The `advanced_command` column values for `settings`, in {@link SETTINGS_COLUMNS} order.
 * @param s - The command settings to persist.
 * @returns The column values, with booleans coerced to 0/1 for the BIT columns.
 */
function settingsParams(s: AdvancedCommandSettings): Array<string | number | null> {
  return [
    s.name, s.triggerString, s.isEnabled ? 1 : 0, s.response, s.pointCost, s.priceStep, s.maxCost,
    s.globalCooldownSeconds, s.userCooldownSeconds, s.minRole, s.liveOnly ? 1 : 0,
    s.maxUsesPerStream, s.maxUsesPerUserPerStream, s.companionEnabled ? 1 : 0,
  ];
}

const SETTINGS_COLUMNS = [
  'name', 'trigger_string', 'is_enabled', 'response', 'point_cost', 'price_step', 'max_cost',
  'global_cooldown_seconds', 'user_cooldown_seconds', 'min_role', 'live_only',
  'max_uses_per_stream', 'max_uses_per_user_per_stream', 'companion_enabled',
];
const SETTINGS_ASSIGNMENTS = SETTINGS_COLUMNS.map((c) => [c, '= ?'].join(' ')).join(', ');

/**
 * Creates an advanced command for a streamer.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param settings - The command's settings; validated and normalised here.
 * @returns The new command's id.
 * @throws `AdvancedCommandValidationError`, `ReservedCommandError`, `CommandConflictError` (the
 *   trigger is a custom command or counter) or {@link AdvancedCommandConflictError}.
 */
export async function addAdvancedCommand(streamerId: number, settings: AdvancedCommandSettings): Promise<number> {
  const normalized = normalizeAdvancedCommandSettings(settings);
  return runGuardedWrite(normalized.triggerString, async (conn) => {
    const [result] = await conn.execute<mysql.ResultSetHeader>(
      `INSERT INTO advanced_command (streamer_id, ${SETTINGS_COLUMNS.join(', ')})
       VALUES (?, ${buildInClausePlaceholders(SETTINGS_COLUMNS.length)})`,
      [streamerId, ...settingsParams(normalized)],
    );
    return result.insertId;
  });
}

/**
 * Replaces one of a streamer's advanced commands' settings.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param commandId - The command's id.
 * @param settings - The new settings; validated and normalised here.
 * @returns True if the command existed (and belongs to the streamer).
 * @throws The same errors as {@link addAdvancedCommand}.
 */
export async function updateAdvancedCommand(
  streamerId: number,
  commandId: number,
  settings: AdvancedCommandSettings,
): Promise<boolean> {
  const normalized = normalizeAdvancedCommandSettings(settings);
  return runGuardedWrite(normalized.triggerString, async (conn) => {
    const [result] = await conn.execute<mysql.ResultSetHeader>(
      `UPDATE advanced_command SET ${SETTINGS_ASSIGNMENTS}
       WHERE id = ? AND streamer_id = ?`,
      [...settingsParams(normalized), commandId, streamerId],
    );
    return result.affectedRows > 0;
  });
}

/**
 * Enables or disables one of a streamer's advanced commands, or toggles it when `enabled` is
 * omitted.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param commandId - The command's id.
 * @param enabled - The new state, or undefined to flip the current one.
 * @returns The command's new enabled state, or null if it doesn't exist for this streamer.
 */
export async function setAdvancedCommandEnabled(
  streamerId: number,
  commandId: number,
  enabled?: boolean,
): Promise<boolean | null> {
  return withTransactionOrNotFound(async (conn, notFound) => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT is_enabled FROM advanced_command WHERE id = ? AND streamer_id = ? FOR UPDATE',
      [commandId, streamerId],
    );
    const row = rows[0];
    if (!row) return notFound();
    const next = enabled ?? !fromBit(row.is_enabled);
    await conn.execute('UPDATE advanced_command SET is_enabled = ? WHERE id = ?', [next ? 1 : 0, commandId]);
    return next;
  });
}

/**
 * Deletes one of a streamer's advanced commands (its effects cascade; its usage log is kept).
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param commandId - The command's id.
 * @returns The command's alert asset filenames (for the caller to delete from disk), or null if
 *   no command was deleted.
 */
export async function removeAdvancedCommand(streamerId: number, commandId: number): Promise<string[] | null> {
  return withTransactionOrNotFound(async (conn, notFound) => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT a.image_filename, a.sound_filename FROM advanced_command ac
       LEFT JOIN advanced_command_alert a ON a.command_id = ac.id
       WHERE ac.id = ? AND ac.streamer_id = ? FOR UPDATE`,
      [commandId, streamerId],
    );
    if (rows.length === 0) return notFound();
    await conn.execute('DELETE FROM advanced_command WHERE id = ? AND streamer_id = ?', [commandId, streamerId]);
    return assetFilenames(rows);
  });
}
