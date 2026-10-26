// Per-streamer advanced commands: pure DB layer with no cache knowledge (the lookup cache is
// invalidated by `advancedCommandWrites.ts`, same split as customCommands/customCommandWrites).
// Every read and write is scoped by `streamer_id`: a streamer can only see and change their own.
import mysql, { type PoolConnection } from 'mysql2/promise';
import { getPool, withTransaction, withTransactionOrNotFound } from './pool';
import { buildInClausePlaceholders, isMysqlDuplicateEntryError, fromBit } from './utils';
import { runSerializedCommandWrite } from './commandWriteGuard';
import type { TextAnimation } from './alertConfig';
import {
  normalizeAdvancedCommandEffects,
  normalizeAdvancedCommandSettings,
  type AdvancedCommandAlert,
  type AdvancedCommandAlertInput,
  type AdvancedCommandEffectsInput,
  type AdvancedCommandParam,
  type AdvancedCommandRole,
  type AdvancedCommandSettings,
} from './advancedCommandValidation';

/** A weighted overlay video assigned to an advanced command, with its file details. */
export interface AdvancedCommandVideo {
  videoId: number;
  weight: number;
  name: string;
  filename: string;
}

/** An advanced command row with its effects. */
export interface DbAdvancedCommand extends AdvancedCommandSettings {
  id: number;
  streamerId: number;
  params: AdvancedCommandParam[];
  videos: AdvancedCommandVideo[];
  alert: AdvancedCommandAlert | null;
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

/**
 * Maps a raw `advanced_command_alert` row to an {@link AdvancedCommandAlert}.
 * @param row - Row selected from `advanced_command_alert`.
 * @returns The mapped alert config.
 */
function mapAlert(row: mysql.RowDataPacket): AdvancedCommandAlert {
  return {
    messageTemplate: row.message_template,
    imageFilename: row.image_filename ?? null,
    soundFilename: row.sound_filename ?? null,
    durationMs: row.duration_ms,
    textAnimation: row.text_animation as TextAnimation,
  };
}

/**
 * Loads the params, videos and alert of `commands` (three queries, however many commands) and
 * attaches them in place.
 * @param commands - The commands to fill in; mutated.
 * @returns The same array, for chaining.
 */
async function attachEffects<T extends DbAdvancedCommand>(commands: T[]): Promise<T[]> {
  if (commands.length === 0) return commands;
  const byId = new Map(commands.map((c) => [c.id, c]));
  const ids = [...byId.keys()];
  const placeholders = buildInClausePlaceholders(ids.length);
  const pool = getPool();
  const [[paramRows], [videoRows], [alertRows]] = await Promise.all([
    pool.execute<mysql.RowDataPacket[]>(
      `SELECT command_id, param_key, param_value FROM advanced_command_param
       WHERE command_id IN (${placeholders}) ORDER BY param_key`, ids),
    pool.execute<mysql.RowDataPacket[]>(
      `SELECT cv.command_id, cv.video_id, cv.weight, v.name, v.filename
       FROM advanced_command_video cv JOIN overlay_video v ON v.id = cv.video_id
       WHERE cv.command_id IN (${placeholders}) ORDER BY v.name`, ids),
    pool.execute<mysql.RowDataPacket[]>(
      `SELECT command_id, message_template, image_filename, sound_filename, duration_ms, text_animation
       FROM advanced_command_alert WHERE command_id IN (${placeholders})`, ids),
  ]);
  for (const r of paramRows) byId.get(r.command_id)?.params.push({ key: r.param_key, value: r.param_value });
  for (const r of videoRows) {
    byId.get(r.command_id)?.videos.push({ videoId: r.video_id, weight: r.weight, name: r.name, filename: r.filename });
  }
  for (const r of alertRows) {
    const command = byId.get(r.command_id);
    if (command) command.alert = mapAlert(r);
  }
  return commands;
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

/**
 * Replaces a command's overlay videos, after checking every video belongs to the same streamer.
 * @param conn - The transaction connection.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param commandId - The command's id.
 * @param videos - The normalised video assignments.
 */
async function replaceVideos(
  conn: PoolConnection,
  streamerId: number,
  commandId: number,
  videos: AdvancedCommandEffectsInput['videos'],
): Promise<void> {
  await conn.execute('DELETE FROM advanced_command_video WHERE command_id = ?', [commandId]);
  if (videos.length === 0) return;
  const ids = videos.map((v) => v.videoId);
  const [owned] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT id FROM overlay_video WHERE streamer_id = ? AND id IN (${buildInClausePlaceholders(ids.length)})`,
    [streamerId, ...ids],
  );
  if (owned.length !== ids.length) throw new Error(`Video not owned by streamer ${streamerId}`);
  await conn.execute(
    `INSERT INTO advanced_command_video (command_id, video_id, weight) VALUES ${videos.map(() => '(?, ?, ?)').join(', ')}`,
    videos.flatMap((v) => [commandId, v.videoId, v.weight]),
  );
}

/**
 * Replaces a command's companion parameters.
 * @param conn - The transaction connection.
 * @param commandId - The command's id.
 * @param params - The normalised parameters.
 */
async function replaceParams(conn: PoolConnection, commandId: number, params: AdvancedCommandParam[]): Promise<void> {
  await conn.execute('DELETE FROM advanced_command_param WHERE command_id = ?', [commandId]);
  if (params.length === 0) return;
  await conn.execute(
    `INSERT INTO advanced_command_param (command_id, param_key, param_value) VALUES ${params.map(() => '(?, ?, ?)').join(', ')}`,
    params.flatMap((p) => [commandId, p.key, p.value]),
  );
}

/**
 * Replaces (or removes, when `alert` is null) a command's alert. Saving keeps the alert's
 * uploaded image and sound; removing it returns their filenames so the caller can delete them.
 * @param conn - The transaction connection.
 * @param commandId - The command's id.
 * @param alert - The normalised alert, or null for none.
 * @returns The filenames orphaned by removing the alert (empty when saving).
 */
async function replaceAlert(conn: PoolConnection, commandId: number, alert: AdvancedCommandAlertInput | null): Promise<string[]> {
  if (!alert) {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT image_filename, sound_filename FROM advanced_command_alert WHERE command_id = ?',
      [commandId],
    );
    await conn.execute('DELETE FROM advanced_command_alert WHERE command_id = ?', [commandId]);
    return assetFilenames(rows);
  }
  await conn.execute(
    `INSERT INTO advanced_command_alert (command_id, message_template, duration_ms, text_animation)
     VALUES (?, ?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE message_template = new_row.message_template,
       duration_ms = new_row.duration_ms, text_animation = new_row.text_animation`,
    [commandId, alert.messageTemplate, alert.durationMs, alert.textAnimation],
  );
  return [];
}

/**
 * Collects the non-null `image_filename`/`sound_filename` values from alert rows.
 * @param rows - Rows from `advanced_command_alert` with `image_filename`/`sound_filename` columns.
 * @returns The non-empty filenames, image then sound per row.
 */
function assetFilenames(rows: mysql.RowDataPacket[]): string[] {
  return rows.flatMap((r) => [r.image_filename, r.sound_filename]).filter((f): f is string => typeof f === 'string' && f !== '');
}

/**
 * Replaces a command's effects — companion parameters, overlay videos and alert — in one
 * transaction, so a bad video id (one the streamer doesn't own) leaves the old effects in place.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param commandId - The command's id.
 * @param effects - The new effects; validated and normalised here.
 * @returns The alert asset filenames orphaned by removing the alert (for the caller to delete
 *   from disk), or null if the command doesn't exist for this streamer.
 * @throws `AdvancedCommandValidationError` on invalid effects.
 */
export async function saveAdvancedCommandEffects(
  streamerId: number,
  commandId: number,
  effects: AdvancedCommandEffectsInput,
): Promise<string[] | null> {
  const normalized = normalizeAdvancedCommandEffects(effects);
  return withTransactionOrNotFound(async (conn, notFound) => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT id FROM advanced_command WHERE id = ? AND streamer_id = ? FOR UPDATE',
      [commandId, streamerId],
    );
    if (rows.length === 0) return notFound();
    await replaceParams(conn, commandId, normalized.params);
    await replaceVideos(conn, streamerId, commandId, normalized.videos);
    return replaceAlert(conn, commandId, normalized.alert);
  });
}

/**
 * Sets (or clears, with null) the uploaded image or sound of a command's alert. The command must
 * belong to the streamer and already have an alert.
 * @param streamerId - The owning streamer's `streamer.id`.
 * @param commandId - The command's id.
 * @param kind - `'image'` or `'sound'`.
 * @param filename - The new stored filename, or null to clear it.
 * @returns `{ previous }` — the replaced filename (null if none) for the caller to delete — or
 *   null if the command or its alert doesn't exist for this streamer.
 */
export async function setAdvancedCommandAlertAsset(
  streamerId: number,
  commandId: number,
  kind: 'image' | 'sound',
  filename: string | null,
): Promise<{ previous: string | null } | null> {
  const column = kind === 'image' ? 'image_filename' : 'sound_filename';
  return withTransactionOrNotFound(async (conn, notFound) => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT a.${column} AS filename FROM advanced_command_alert a
       JOIN advanced_command ac ON ac.id = a.command_id
       WHERE a.command_id = ? AND ac.streamer_id = ? FOR UPDATE`,
      [commandId, streamerId],
    );
    const row = rows[0];
    if (!row) return notFound();
    await conn.execute(`UPDATE advanced_command_alert SET ${column} = ? WHERE command_id = ?`, [filename, commandId]);
    return { previous: (row.filename as string | null) ?? null };
  });
}
