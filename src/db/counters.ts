import mysql from 'mysql2/promise';
import { getPool, withTransaction } from './pool';
import { requireTrimmedString, normalizeCommand, normalizeCommandList } from './commandStringUtils';
import { CommandConflictError } from './commandErrors';
import { runSerializedCommandWrite, isAnyCommandTakenAcrossTables } from './commandWriteGuard';
import { assertNotReservedCommand } from './reservedCommands';
import { fromBit, affectedOrExists, type SqlExecutor } from './utils';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DbCounter {
  id: number;
  guild_id: string;
  trigger_command: string;
  check_command: string;
  message: string;
  increment_message: string;
  reset_yearly: boolean;
  current_value: number;
}

export type CounterMatchType = 'trigger' | 'check';

export interface DbMatchedCounter extends DbCounter {
  matchType: CounterMatchType;
}

/** A counter's editable fields, shared by {@link addCounter} and {@link UpdateCounterInput}. */
export interface CounterFieldsInput {
  triggerCommand: string;
  checkCommand: string;
  message: string;
  incrementMessage: string;
  resetYearly: boolean;
}

export interface UpdateCounterInput extends CounterFieldsInput {
  id: number;
}

/** Thrown when a counter lookup/mutation matches no row. */
export class CounterNotFoundError extends Error {
  constructor(id: number) {
    super(`Counter not found: ${id}`);
    this.name = 'CounterNotFoundError';
  }
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

/** Maps a raw `counter` table row to a {@link DbCounter}. `guild_id` is a Discord snowflake
 *  (BIGINT) — kept as the string the driver returns, never coerced to `Number`. */
export function mapCounter(row: mysql.RowDataPacket): DbCounter {
  return {
    id: row.id,
    guild_id: String(row.guild_id),
    trigger_command: row.trigger_command,
    check_command: row.check_command,
    message: row.message,
    increment_message: row.increment_message,
    reset_yearly: fromBit(row.reset_yearly),
    current_value: row.current_value,
  };
}

// ─── Normalisation ────────────────────────────────────────────────────────────

interface NormalizedCounterFields {
  triggerCommand: string;
  checkCommand: string;
  message: string;
  incrementMessage: string;
}

/**
 * Trims and validates a counter's editable fields (lowercasing the trigger/check commands),
 * enforcing per-field length limits.
 * @param triggerCommand Command that increments the counter.
 * @param checkCommand Command that reports the counter's current value.
 * @param message Message shown when the counter is checked.
 * @param incrementMessage Message shown when the counter is incremented.
 * @returns The normalized fields.
 * @throws If any field is blank or exceeds its maximum length.
 */
function normalizeCounterFields(
  triggerCommand: string,
  checkCommand: string,
  message: string,
  incrementMessage: string,
): NormalizedCounterFields {
  return {
    triggerCommand: requireTrimmedString(triggerCommand, 'trigger_command', 255).toLowerCase(),
    checkCommand: requireTrimmedString(checkCommand, 'check_command', 255).toLowerCase(),
    message: requireTrimmedString(message, 'message', 2000),
    incrementMessage: requireTrimmedString(incrementMessage, 'increment_message', 2000),
  };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export const COUNTER_COLUMNS = 'id, guild_id, trigger_command, check_command, message, increment_message, reset_yearly, current_value';

/**
 * Fetches every counter across every guild, ordered by trigger command. Used by the runtime
 * command-lookup cache ({@link findCounterByCommand}), which buckets the result per guild in
 * memory — for a single guild's counters (e.g. the admin panel), use {@link getCountersForGuild}
 * instead.
 * @returns All counters, across every guild.
 */
export async function getAllCounters(): Promise<DbCounter[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${COUNTER_COLUMNS}
     FROM counter
     ORDER BY trigger_command`,
  );
  return rows.map(mapCounter);
}

/**
 * Fetches all counters belonging to one guild, ordered by trigger command.
 * @param guildId The guild to fetch counters for.
 * @returns That guild's counters.
 */
export async function getCountersForGuild(guildId: string): Promise<DbCounter[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${COUNTER_COLUMNS}
     FROM counter
     WHERE guild_id = ?
     ORDER BY trigger_command`,
    [guildId],
  );
  return rows.map(mapCounter);
}

/** Return the number of counters belonging to one guild, for the dashboard's usage-stats summary. */
export async function getCounterCount(guildId: string): Promise<number> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM counter WHERE guild_id = ?',
    [guildId],
  );
  // COUNT(*) is protocol-typed BIGINT, so bigNumberStrings stringifies it — but like
  // getRowCount in utils.ts, this value is bounded by how many counters a human configures in
  // one guild's admin panel, nowhere near Number.MAX_SAFE_INTEGER, so parsing it back is safe.
  return Number.parseInt(rows[0]!.count, 10); // COUNT(*) always returns exactly one row
}

// ─── Collision check ──────────────────────────────────────────────────────────

/** Returns true if any of the given commands conflict with an existing counter in this guild
 *  (optionally excluding one by ID). Counters in other guilds never collide. */
export async function isCounterCommandTaken(guildId: string, commandOrCommands: string | string[], excludeCounterId?: number): Promise<boolean> {
  if (Array.isArray(commandOrCommands)) {
    const normalizedCommands = normalizeCommandList(commandOrCommands);
    if (new Set(normalizedCommands).size !== normalizedCommands.length) {
      return true;
    }
  }

  return isAnyCommandTakenAcrossTables(commandOrCommands, { excludeCounterId, guildId });
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Creates a new counter, starting at 0, after validating fields and checking the trigger/check
 * commands don't conflict with other reserved or in-use commands (globally for other guilds'
 * custom commands, and within this guild for other counters — the same trigger/check command may
 * exist in a different guild's counter without colliding).
 * @param guildId The guild this counter belongs to.
 * @param input The counter's initial fields.
 * @throws If `triggerCommand` and `checkCommand` are the same, either is reserved, or either is
 *   already taken by another command.
 */
export async function addCounter(guildId: string, input: CounterFieldsInput): Promise<void> {
  const { triggerCommand, checkCommand, message, incrementMessage, resetYearly } = input;
  const fields = normalizeCounterFields(triggerCommand, checkCommand, message, incrementMessage);
  if (fields.triggerCommand === fields.checkCommand) {
    throw new Error('Counter trigger_command and check_command must be different');
  }

  assertNotReservedCommand(fields.triggerCommand);
  assertNotReservedCommand(fields.checkCommand);

  await runSerializedCommandWrite(
    [fields.triggerCommand, fields.checkCommand],
    { guildId },
    async (connection) => {
      await connection.execute(
        `INSERT INTO counter (guild_id, trigger_command, check_command, message, increment_message, reset_yearly, current_value)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [guildId, fields.triggerCommand, fields.checkCommand, fields.message, fields.incrementMessage, resetYearly ? 1 : 0],
      );
    },
  );
}

/**
 * Checks whether a counter with the given id exists in this guild.
 * @param guildId The guild the counter must belong to.
 * @param id The counter's numeric id.
 * @param executor Pool or transaction connection to query with.
 * @returns True if a counter with that id exists in this guild.
 */
async function counterExists(guildId: string, id: number, executor: SqlExecutor = getPool()): Promise<boolean> {
  const [rows] = await executor.execute<mysql.RowDataPacket[]>(
    'SELECT 1 FROM counter WHERE id = ? AND guild_id = ? LIMIT 1',
    [id, guildId],
  );
  return rows.length > 0;
}

/**
 * Looks up a counter's current trigger/check command strings by id, scoped to one guild.
 * @param guildId The guild the counter must belong to.
 * @param id The counter's numeric id.
 * @param executor Pool or transaction connection to query with.
 * @returns The counter's trigger and check commands, or `null` if no counter with the given id
 *   exists in this guild.
 */
async function getCounterCommandsById(
  guildId: string,
  id: number,
  executor: SqlExecutor = getPool(),
): Promise<{ trigger_command: string; check_command: string } | null> {
  const [rows] = await executor.execute<mysql.RowDataPacket[]>(
    'SELECT trigger_command, check_command FROM counter WHERE id = ? AND guild_id = ? LIMIT 1',
    [id, guildId],
  );
  const row = rows[0];
  if (!row) return null;
  return { trigger_command: row.trigger_command, check_command: row.check_command };
}

/** Disables `runSerializedCommandWrite`'s built-in collision check, leaving it to lock only. */
const LOCK_ONLY_CHECKS = { includeCustomCommandTable: false, includeCounterTable: false } as const;

/**
 * Updates an existing counter's fields, locking both its old and new trigger/check commands
 * so concurrent writes can't create a conflict during the transition. Only the new commands the
 * counter doesn't already own are collision-checked, so a counter whose existing command already
 * collides (pre-existing data) can still be edited or renamed away from the collision.
 * @param guildId The guild the counter must belong to.
 * @param input The counter's id and updated fields.
 * @throws {CounterNotFoundError} If no counter with the given id exists in this guild.
 * @throws If `triggerCommand` and `checkCommand` are the same, either is reserved, or either is
 *   already taken by another command.
 */
export async function updateCounter(guildId: string, input: UpdateCounterInput): Promise<void> {
  const { id, triggerCommand, checkCommand, message, incrementMessage, resetYearly } = input;

  const fields = normalizeCounterFields(triggerCommand, checkCommand, message, incrementMessage);
  if (fields.triggerCommand === fields.checkCommand) {
    throw new Error('Counter trigger_command and check_command must be different');
  }

  assertNotReservedCommand(fields.triggerCommand);
  assertNotReservedCommand(fields.checkCommand);

  const current = await getCounterCommandsById(guildId, id);
  if (!current) throw new CounterNotFoundError(id);

  // Lock old commands too so concurrent adds/updates can't sneak in during the
  // transition window while the old trigger/check names are being released.
  const commandsToLock = [
    normalizeCommand(current.trigger_command) ?? '',
    normalizeCommand(current.check_command) ?? '',
    fields.triggerCommand,
    fields.checkCommand,
  ];

  await runSerializedCommandWrite(
    commandsToLock,
    { guildId },
    async (connection) => {
      // Re-read under the locks, then collision-check only the commands this counter is
      // gaining; re-checking ones it already holds would block every edit of a counter that
      // already collides with something.
      const locked = await getCounterCommandsById(guildId, id, connection);
      if (!locked) throw new CounterNotFoundError(id);
      const owned = new Set([normalizeCommand(locked.trigger_command), normalizeCommand(locked.check_command)]);
      const added = [fields.triggerCommand, fields.checkCommand].filter((command) => !owned.has(command));
      if (added.length > 0
        && await isAnyCommandTakenAcrossTables(added, { excludeCounterId: id, guildId }, connection)) {
        throw new CommandConflictError(added);
      }

      const [result] = await connection.execute<mysql.ResultSetHeader>(
        `UPDATE counter
         SET trigger_command = ?,
             check_command = ?,
             message = ?,
             increment_message = ?,
             reset_yearly = ?
         WHERE id = ? AND guild_id = ?`,
        [fields.triggerCommand, fields.checkCommand, fields.message, fields.incrementMessage, resetYearly ? 1 : 0, id, guildId],
      );

      if (!(await affectedOrExists(result.affectedRows, () => counterExists(guildId, id, connection)))) {
        throw new CounterNotFoundError(id);
      }
    },
    LOCK_ONLY_CHECKS,
  );
}

/**
 * Deletes a counter by id, locking its trigger/check commands during the delete. No collision
 * check runs — deleting only releases commands — so a counter that already collides with another
 * command can still be removed.
 * @param guildId The guild the counter must belong to.
 * @param id The counter's numeric id.
 * @throws {CounterNotFoundError} If no counter with the given id exists in this guild.
 */
export async function removeCounter(guildId: string, id: number): Promise<void> {
  const current = await getCounterCommandsById(guildId, id);
  if (!current) throw new CounterNotFoundError(id);

  await runSerializedCommandWrite(
    [current.trigger_command, current.check_command],
    { guildId },
    async (connection) => {
      const [result] = await connection.execute<mysql.ResultSetHeader>(
        'DELETE FROM counter WHERE id = ? AND guild_id = ?',
        [id, guildId],
      );
      if (result.affectedRows === 0) throw new CounterNotFoundError(id);
    },
    LOCK_ONLY_CHECKS,
  );
}

/**
 * Resets a counter's `current_value` to 0.
 * @param guildId The guild the counter must belong to.
 * @param id The counter's numeric id.
 * @throws {CounterNotFoundError} If no counter with the given id exists in this guild.
 */
export async function resetCounterCurrentValue(guildId: string, id: number): Promise<void> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    'UPDATE counter SET current_value = 0 WHERE id = ? AND guild_id = ?',
    [id, guildId],
  );

  if (!(await affectedOrExists(result.affectedRows, () => counterExists(guildId, id)))) {
    throw new CounterNotFoundError(id);
  }
}

/**
 * Atomically increments a counter's `current_value` and returns the new value.
 *
 * Uses the `LAST_INSERT_ID(expr)` trick to learn the post-increment value: the `UPDATE`
 * stashes the computed value in the connection's session-scoped `LAST_INSERT_ID()`, so the
 * follow-up `SELECT LAST_INSERT_ID()` reads connection state rather than re-reading the
 * `counter` table/index — cheaper than a second `SELECT ... FROM counter WHERE id = ?`, and
 * this function runs on every chat message that hits an active counter's trigger command.
 *
 * @param id The counter's numeric id.
 * @returns The counter's `current_value` after the increment.
 * @throws {CounterNotFoundError} If no counter exists with the given id.
 */
export async function incrementCounter(id: number): Promise<number> {
  const newValue = await withTransaction(async (conn) => {
    const [result] = await conn.execute<mysql.ResultSetHeader>(
      'UPDATE counter SET current_value = LAST_INSERT_ID(current_value + 1) WHERE id = ?',
      [id],
    );
    if (result.affectedRows === 0) throw new CounterNotFoundError(id);
    const [rows] = await conn.execute<mysql.RowDataPacket[]>('SELECT LAST_INSERT_ID() AS current_value');
    // LAST_INSERT_ID() is a BIGINT expression, so the pool's bigNumberStrings setting can
    // return it as a string even though `current_value` itself is a plain INT column — parse
    // it back with Number() rather than trusting the driver's JS type. Safe here: this is an
    // application counter incremented one chat message at a time, nowhere near
    // Number.MAX_SAFE_INTEGER (unlike a Discord snowflake, which is why that case is never
    // parsed back this way elsewhere in this codebase).
    return Number(rows[0]!.current_value); // SELECT LAST_INSERT_ID() always returns one row
  });
  return newValue;
}
