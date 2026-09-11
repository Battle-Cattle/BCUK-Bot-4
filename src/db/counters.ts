import mysql from 'mysql2/promise';
import { getPool, withTransaction } from './pool';
import { requireTrimmedString, normalizeCommand, type SqlExecutor } from './commandStringUtils';
import { runSerializedCommandWrite } from './commandLocks';
import { assertNotReservedCommand } from './reservedCommands';
import { fromBit, affectedOrExists } from './utils';
import {
  createManagedLookupCache,
  type RefreshingLookupCache,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
} from './lookupCache';

// ─── Archive column allowlist ─────────────────────────────────────────────────
// MySQL does not support parameterised column names. Rather than building the
// name dynamically from a validated integer at call-time, we pre-compute every
// valid mapping here so the string that reaches the SQL template is always
// drawn from a fixed, auditable set.
const ARCHIVE_YEAR_COLUMNS = new Map<number, string>(
  Array.from({ length: 2100 - 2020 + 1 }, (_, i) => [2020 + i, `value${2020 + i}`] as [number, string]),
);

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

/** A single archived year's value for a counter, as returned by {@link getCounterHistory}. */
export interface CounterHistoryEntry {
  year: number;
  value: number | null;
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

/** Maps a raw `counter` table row to a {@link DbCounter}. `guild_id` is a Discord snowflake
 *  (BIGINT) — kept as the string the driver returns, never coerced to `Number`. */
function mapCounter(row: mysql.RowDataPacket): DbCounter {
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

const COUNTER_COLUMNS = 'id, guild_id, trigger_command, check_command, message, increment_message, reset_yearly, current_value';

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
  return Number.parseInt((rows[0] as mysql.RowDataPacket).count, 10);
}

/**
 * Fetches a counter along with its archived yearly-reset history (the
 * `value2020`..`value2100` columns populated by `archiveAndResetYearlyCounters`).
 * @param id - The counter's numeric id.
 * @returns The counter and its history (years with a non-null archived value, newest
 *   first), or `null` if no counter exists with the given id.
 */
// ─── Archive column existence cache ───────────────────────────────────────────
// `value<year>` columns are only ever added via yearly migrations (see
// DATABASE-SCHEMA.md), so a short TTL is enough to turn "one information_schema
// round-trip per getCounterHistory call" into "one per 5 minutes", which matters
// when an admin browses several counters' histories in one session.

interface ArchiveColumnsCache extends RefreshingLookupCache {
  columns: string[];
}

const archiveColumnsCacheState = createManagedLookupCache<ArchiveColumnsCache>({
  cacheName: 'counter archive columns cache',
  ttlMs: DEFAULT_CACHE_TTL_MS,
  refreshFailureBackoffMs: DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: () => ({ loadedAt: 0, columns: [] }),
  loadCache: async () => {
    const [rows] = await getPool().query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'counter' AND COLUMN_NAME LIKE 'value2%'`,
    );
    // The current year (and any future year) can never have valid archived data —
    // archiveAndResetYearlyCounters only ever writes into the *previous* completed
    // year's column, on Jan 1. Exclude them even if the column already physically
    // exists (e.g. pre-provisioned ahead of the year rolling over) and even if it
    // somehow holds a non-null value, rather than relying solely on the NULL
    // filter in getCounterHistory to hide it.
    const currentYear = new Date().getFullYear();
    const eligibleColumns = new Set(
      Array.from(ARCHIVE_YEAR_COLUMNS.entries())
        .filter(([year]) => year < currentYear)
        .map(([, columnName]) => columnName),
    );
    const columns = rows
      .map((row) => row.COLUMN_NAME as string)
      .filter((columnName) => eligibleColumns.has(columnName));
    return { loadedAt: Date.now(), columns };
  },
});

/** Marks the archive-columns cache as stale so the next read re-queries `information_schema`. */
export function invalidateArchiveColumnsCache(): void {
  archiveColumnsCacheState.invalidate();
}

/**
 * Returns the `value<year>` archive columns that actually exist on the `counter`
 * table AND belong to a year strictly before the current calendar year (cached
 * for 5 minutes — see `archiveColumnsCacheState`). Per `DATABASE-SCHEMA.md`,
 * these columns are added incrementally over time (one per year, as each year's
 * archive becomes needed) — `ARCHIVE_YEAR_COLUMNS` is a fixed allowlist of
 * *theoretically valid* years, not a guarantee that every column in it has been
 * created yet, so callers must not assume the full range exists. The current
 * year and any future year are excluded outright, since they can never have
 * valid archived data (see `archiveAndResetYearlyCounters`).
 */
async function getExistingArchiveColumns(): Promise<string[]> {
  const cache = await archiveColumnsCacheState.getCache();
  return cache.columns;
}

/**
 * Fetches a counter along with its archived yearly-reset history (the
 * `value<year>` columns populated by `archiveAndResetYearlyCounters`). Only reads
 * columns that actually exist on the `counter` table right now (see
 * `getExistingArchiveColumns`), since not every year in `ARCHIVE_YEAR_COLUMNS` is
 * guaranteed to be a physical column yet.
 * @param guildId - The guild the counter must belong to.
 * @param id - The counter's numeric id.
 * @returns The counter and its archived history (years with a non-null value,
 *   newest first), or `null` if no counter with the given id exists in this guild.
 */
export async function getCounterHistory(
  guildId: string,
  id: number,
): Promise<{ counter: DbCounter; history: CounterHistoryEntry[] } | null> {
  const existingColumns = await getExistingArchiveColumns();
  const selectColumns = existingColumns.length > 0
    ? `, ${existingColumns.map((col) => `\`${col}\``).join(', ')}`
    : '';
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${COUNTER_COLUMNS}${selectColumns}
     FROM counter
     WHERE id = ? AND guild_id = ?
     LIMIT 1`,
    [id, guildId],
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  const counter = mapCounter(row);
  const existingColumnSet = new Set(existingColumns);
  const history: CounterHistoryEntry[] = Array.from(ARCHIVE_YEAR_COLUMNS.entries())
    .filter(([, columnName]) => existingColumnSet.has(columnName) && row[columnName] !== null && row[columnName] !== undefined)
    .map(([year, columnName]) => ({ year, value: row[columnName] as number }))
    .sort((a, b) => b.year - a.year);

  return { counter, history };
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
  if (rows.length === 0) return null;
  return { trigger_command: rows[0].trigger_command, check_command: rows[0].check_command };
}

/**
 * Updates an existing counter's fields, locking both its old and new trigger/check commands
 * so concurrent writes can't create a conflict during the transition.
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
    { excludeCounterId: id, guildId },
    async (connection) => {
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
  );
}

/**
 * Deletes a counter by id, locking its trigger/check commands during the delete.
 * @param guildId The guild the counter must belong to.
 * @param id The counter's numeric id.
 * @throws {CounterNotFoundError} If no counter with the given id exists in this guild.
 */
export async function removeCounter(guildId: string, id: number): Promise<void> {
  const current = await getCounterCommandsById(guildId, id);
  if (!current) throw new CounterNotFoundError(id);

  await runSerializedCommandWrite(
    [current.trigger_command, current.check_command],
    { excludeCounterId: id, guildId },
    async (connection) => {
      const [result] = await connection.execute<mysql.ResultSetHeader>(
        'DELETE FROM counter WHERE id = ? AND guild_id = ?',
        [id, guildId],
      );
      if (result.affectedRows === 0) throw new CounterNotFoundError(id);
    },
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
    return Number((rows[0] as mysql.RowDataPacket).current_value);
  });
  return newValue;
}

/**
 * Archives the current value of every yearly-reset counter into that year's `value<year>`
 * column (only for counters where the column is still `NULL`), then resets `current_value` to 0.
 * @param year Calendar year to archive into; must be a key of `ARCHIVE_YEAR_COLUMNS`.
 * @returns The number of counters archived and reset.
 * @throws If `year` is not a valid archive year.
 */
export async function archiveAndResetYearlyCounters(year: number): Promise<number> {
  const columnName = ARCHIVE_YEAR_COLUMNS.get(year);
  if (!columnName) {
    throw new Error(`[DB] Invalid archive year: ${year}`);
  }
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE counter SET \`${columnName}\` = current_value, current_value = 0 WHERE reset_yearly = 1 AND \`${columnName}\` IS NULL`,
  );
  return result.affectedRows;
}
