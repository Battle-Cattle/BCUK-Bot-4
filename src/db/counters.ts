import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { requireTrimmedString, type SqlExecutor } from './commandStringUtils';
import { runSerializedCommandWrite } from './commandLocks';
import { assertNotReservedCommand } from './reservedCommands';
import { fromBit } from './utils';
import { invalidateCounterLookupCache } from './counterCache';

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

export interface UpdateCounterInput {
  id: number;
  triggerCommand: string;
  checkCommand: string;
  message: string;
  incrementMessage: string;
  resetYearly: boolean;
}

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

function mapCounter(row: mysql.RowDataPacket): DbCounter {
  return {
    id: row.id,
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

export async function getAllCounters(): Promise<DbCounter[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, trigger_command, check_command, message, increment_message, reset_yearly, current_value
     FROM counter
     ORDER BY trigger_command`,
  );
  return rows.map(mapCounter);
}

/**
 * Fetches a counter along with its archived yearly-reset history (the
 * `value2020`..`value2100` columns populated by `archiveAndResetYearlyCounters`).
 * @param id - The counter's numeric id.
 * @returns The counter and its history (years with a non-null archived value, newest
 *   first), or `null` if no counter exists with the given id.
 */
export async function getCounterHistory(
  id: number,
): Promise<{ counter: DbCounter; history: CounterHistoryEntry[] } | null> {
  const archiveColumns = Array.from(ARCHIVE_YEAR_COLUMNS.values());
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, trigger_command, check_command, message, increment_message, reset_yearly, current_value,
            ${archiveColumns.map((col) => `\`${col}\``).join(', ')}
     FROM counter
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  const counter = mapCounter(row);
  const history: CounterHistoryEntry[] = Array.from(ARCHIVE_YEAR_COLUMNS.entries())
    .filter(([, columnName]) => row[columnName] !== null && row[columnName] !== undefined)
    .map(([year, columnName]) => ({ year, value: row[columnName] as number }))
    .sort((a, b) => b.year - a.year);

  return { counter, history };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function addCounter(
  triggerCommand: string,
  checkCommand: string,
  message: string,
  incrementMessage: string,
  resetYearly: boolean,
): Promise<void> {
  const fields = normalizeCounterFields(triggerCommand, checkCommand, message, incrementMessage);
  if (fields.triggerCommand === fields.checkCommand) {
    throw new Error('Counter trigger_command and check_command must be different');
  }

  assertNotReservedCommand(fields.triggerCommand);
  assertNotReservedCommand(fields.checkCommand);

  await runSerializedCommandWrite(
    [fields.triggerCommand, fields.checkCommand],
    undefined,
    async (connection) => {
      await connection.execute(
        `INSERT INTO counter (trigger_command, check_command, message, increment_message, reset_yearly, current_value)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [fields.triggerCommand, fields.checkCommand, fields.message, fields.incrementMessage, resetYearly ? 1 : 0],
      );
    },
  );

  invalidateCounterLookupCache();
}

async function counterExists(id: number, executor: SqlExecutor = getPool()): Promise<boolean> {
  const [rows] = await executor.execute<mysql.RowDataPacket[]>(
    'SELECT 1 FROM counter WHERE id = ? LIMIT 1',
    [id],
  );
  return rows.length > 0;
}

async function getCounterCommandsById(
  id: number,
  executor: SqlExecutor = getPool(),
): Promise<{ trigger_command: string; check_command: string } | null> {
  const [rows] = await executor.execute<mysql.RowDataPacket[]>(
    'SELECT trigger_command, check_command FROM counter WHERE id = ? LIMIT 1',
    [id],
  );
  if (rows.length === 0) return null;
  return { trigger_command: rows[0].trigger_command, check_command: rows[0].check_command };
}

export async function updateCounter(input: UpdateCounterInput): Promise<void> {
  const { id, triggerCommand, checkCommand, message, incrementMessage, resetYearly } = input;

  const fields = normalizeCounterFields(triggerCommand, checkCommand, message, incrementMessage);
  if (fields.triggerCommand === fields.checkCommand) {
    throw new Error('Counter trigger_command and check_command must be different');
  }

  assertNotReservedCommand(fields.triggerCommand);
  assertNotReservedCommand(fields.checkCommand);

  const current = await getCounterCommandsById(id);
  if (!current) throw new CounterNotFoundError(id);

  // Lock old commands too so concurrent adds/updates can't sneak in during the
  // transition window while the old trigger/check names are being released.
  const commandsToLock = [
    current.trigger_command.trim().toLowerCase(),
    current.check_command.trim().toLowerCase(),
    fields.triggerCommand,
    fields.checkCommand,
  ];

  await runSerializedCommandWrite(
    commandsToLock,
    { excludeCounterId: id },
    async (connection) => {
      const [result] = await connection.execute<mysql.ResultSetHeader>(
        `UPDATE counter
         SET trigger_command = ?,
             check_command = ?,
             message = ?,
             increment_message = ?,
             reset_yearly = ?
         WHERE id = ?`,
        [fields.triggerCommand, fields.checkCommand, fields.message, fields.incrementMessage, resetYearly ? 1 : 0, id],
      );

      if (result.affectedRows === 0 && !(await counterExists(id, connection))) {
        throw new CounterNotFoundError(id);
      }
    },
  );

  invalidateCounterLookupCache();
}

export async function removeCounter(id: number): Promise<void> {
  const current = await getCounterCommandsById(id);
  if (!current) throw new CounterNotFoundError(id);

  await runSerializedCommandWrite(
    [current.trigger_command, current.check_command],
    { excludeCounterId: id },
    async (connection) => {
      const [result] = await connection.execute<mysql.ResultSetHeader>(
        'DELETE FROM counter WHERE id = ?',
        [id],
      );
      if (result.affectedRows === 0) throw new CounterNotFoundError(id);
    },
  );

  invalidateCounterLookupCache();
}

export async function resetCounterCurrentValue(id: number): Promise<void> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    'UPDATE counter SET current_value = 0 WHERE id = ?',
    [id],
  );

  if (result.affectedRows === 0) {
    if (!(await counterExists(id))) throw new CounterNotFoundError(id);
    // Counter exists but value was already 0 — nothing changed, skip invalidation.
    return;
  }

  invalidateCounterLookupCache();
}

export async function incrementCounter(id: number): Promise<number> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute<mysql.ResultSetHeader>(
      'UPDATE counter SET current_value = current_value + 1 WHERE id = ?',
      [id],
    );
    if (result.affectedRows === 0) throw new CounterNotFoundError(id);
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT current_value FROM counter WHERE id = ?',
      [id],
    );
    const newValue = (rows[0] as mysql.RowDataPacket).current_value as number;
    await conn.commit();
    invalidateCounterLookupCache();
    return newValue;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export async function archiveAndResetYearlyCounters(year: number): Promise<number> {
  const columnName = ARCHIVE_YEAR_COLUMNS.get(year);
  if (!columnName) {
    throw new Error(`[DB] Invalid archive year: ${year}`);
  }
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE counter SET \`${columnName}\` = current_value, current_value = 0 WHERE reset_yearly = 1 AND \`${columnName}\` IS NULL`,
  );
  invalidateCounterLookupCache();
  return result.affectedRows;
}
