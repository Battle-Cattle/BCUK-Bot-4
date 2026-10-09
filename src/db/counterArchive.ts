// Yearly counter archiving: the `value<year>` columns that `archiveAndResetYearlyCounters` fills
// each 1 January, and `getCounterHistory`, which reads them back. Split from `counters.ts`, which
// keeps the counter CRUD; the cache invalidation wrapper for the archive run lives in `counterWrites.ts`.
import mysql from 'mysql2/promise';
import { getPool, withTransaction } from './pool';
import { mapCounter, COUNTER_COLUMNS, type DbCounter } from './counters';
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

/** A single archived year's value for a counter, as returned by {@link getCounterHistory}. */
export interface CounterHistoryEntry {
  year: number;
  value: number | null;
}

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
    // year's column (from 1 January onward). Exclude them even if the column already physically
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
  const row = rows[0];
  if (!row) return null;

  const counter = mapCounter(row);
  const existingColumnSet = new Set(existingColumns);
  const history: CounterHistoryEntry[] = Array.from(ARCHIVE_YEAR_COLUMNS.entries())
    .filter(([, columnName]) => existingColumnSet.has(columnName) && row[columnName] !== null && row[columnName] !== undefined)
    .map(([year, columnName]) => ({ year, value: row[columnName] as number }))
    .sort((a, b) => b.year - a.year);

  return { counter, history };
}

/**
 * Adds the `counter.<columnName>` archive column (`INT NULL`) if it doesn't exist yet, so each
 * year's archive doesn't depend on someone adding the column by hand beforehand. Tolerates a
 * concurrent add (`ER_DUP_FIELDNAME`) and invalidates the archive-columns cache after adding.
 * Requires the bot's DB user to have `ALTER` on `counter`; without it this throws and the
 * scheduler retries on its next tick.
 * @param columnName A `value<year>` column name drawn from `ARCHIVE_YEAR_COLUMNS` (never user input).
 * @returns Resolves once the column is known to exist.
 */
async function ensureArchiveColumn(columnName: string): Promise<void> {
  const [rows] = await getPool().query<mysql.RowDataPacket[]>(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'counter' AND COLUMN_NAME = ?`,
    [columnName],
  );
  if (rows.length > 0) return;
  try {
    await getPool().query(`ALTER TABLE counter ADD COLUMN \`${columnName}\` INT NULL`);
  } catch (err) {
    const mysqlError = err as { code?: string; errno?: number };
    if (mysqlError.code !== 'ER_DUP_FIELDNAME' && mysqlError.errno !== 1060) throw err;
  }
  invalidateArchiveColumnsCache();
}

/**
 * Archives the current value of every yearly-reset counter into that year's `value<year>`
 * column (only for counters where the column is still `NULL`), then resets `current_value` to 0 —
 * at most once per `year`, tracked by a persistent `counter_archive_run` marker row.
 *
 * First makes sure the `value<year>` column exists, adding it if it doesn't (see
 * {@link ensureArchiveColumn}); that runs before the transaction because DDL implicitly commits.
 *
 * Then runs one transaction: first claims `year` by inserting its marker row (`INSERT IGNORE`);
 * if the row already existed, that year was already archived and this returns 0 without touching
 * any counter. Otherwise runs the archive/reset `UPDATE`. Any failure (including a missing
 * `counter_archive_run` table) rolls back the marker too, so the next scheduler tick retries.
 * The marker is what lets the scheduler attempt archival on every tick (catching up after
 * downtime spanning 1 January) without re-resetting counters mid-year.
 * @param year Calendar year to archive into; must be a key of `ARCHIVE_YEAR_COLUMNS`.
 * @returns The number of counters archived and reset (0 if `year` was already archived).
 * @throws If `year` is not a valid archive year, the column can't be added, or the transaction fails.
 */
export async function archiveAndResetYearlyCounters(year: number): Promise<number> {
  const columnName = ARCHIVE_YEAR_COLUMNS.get(year);
  if (!columnName) {
    throw new Error(`[DB] Invalid archive year: ${year}`);
  }
  await ensureArchiveColumn(columnName);
  return withTransaction(async (conn) => {
    const [claim] = await conn.execute<mysql.ResultSetHeader>(
      'INSERT IGNORE INTO counter_archive_run (archive_year) VALUES (?)',
      [year],
    );
    if (claim.affectedRows === 0) return 0; // marker already present — year already archived
    const [result] = await conn.execute<mysql.ResultSetHeader>(
      `UPDATE counter SET \`${columnName}\` = current_value, current_value = 0 WHERE reset_yearly = 1 AND \`${columnName}\` IS NULL`,
    );
    return result.affectedRows;
  });
}
