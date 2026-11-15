import type mysql from 'mysql2/promise';
import { getPool } from '../db';

// Generic rows for the real-MySQL tests (`npm run test:db`): `insertRow` fills any table's required
// columns from information_schema, creating the parent rows its foreign keys need, so a test can
// put a row in dozens of tables without hand-writing each one. Values are placeholders: a test
// that cares about a column passes it explicitly.

/** A foreign key, as MySQL reports it. */
export interface ForeignKey {
  table: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
  /** `CASCADE`, `SET NULL`, `RESTRICT` or `NO ACTION`. */
  deleteRule: string;
}

/** A column `insertRow` must fill: NOT NULL, with no default and no auto-increment. */
interface RequiredColumn {
  name: string;
  dataType: string;
  columnType: string;
}

/** What `insertRow` knows about a table. */
interface TableInfo {
  required: RequiredColumn[];
  /** The auto-increment column, if any, whose value comes back as the insert id. */
  autoIncrement: string | null;
}

const NUMERIC_TYPES = new Set(['int', 'bigint', 'smallint', 'decimal']);
const STRING_TYPES = new Set(['char', 'varchar', 'text']);

// Numbers start here, so every generated value passes the schema's CHECK constraints (`> 0`,
// `>= 60`) and is unique within a run.
let nextValue = 1000;

const tableInfoCache = new Map<string, Promise<TableInfo>>();
let foreignKeyCache: Promise<ForeignKey[]> | undefined;

/**
 * Lists every foreign key in the current database. Cached: the schema doesn't change mid-run.
 * @returns The foreign keys, ordered by referenced table, then table and column.
 */
export async function foreignKeys(): Promise<ForeignKey[]> {
  foreignKeyCache ??= getPool().query<mysql.RowDataPacket[]>(
    `SELECT k.TABLE_NAME AS tableName, k.COLUMN_NAME AS columnName, k.REFERENCED_TABLE_NAME AS referencedTable,
            k.REFERENCED_COLUMN_NAME AS referencedColumn, r.DELETE_RULE AS deleteRule
     FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.REFERENTIAL_CONSTRAINTS r
       ON r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
     WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY k.REFERENCED_TABLE_NAME, k.TABLE_NAME, k.COLUMN_NAME`,
  ).then(([rows]) => rows.map((r) => ({
    table: String(r.tableName),
    column: String(r.columnName),
    referencedTable: String(r.referencedTable),
    referencedColumn: String(r.referencedColumn),
    deleteRule: String(r.deleteRule),
  })));
  return foreignKeyCache;
}

/**
 * Reads the columns `insertRow` must fill for a table, and its auto-increment column. Cached.
 * @param table Table name.
 * @returns The table's required columns and auto-increment column.
 */
async function tableInfo(table: string): Promise<TableInfo> {
  let info = tableInfoCache.get(table);
  if (!info) {
    info = getPool().query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
              IS_NULLABLE AS nullable, COLUMN_DEFAULT AS columnDefault, EXTRA AS extra
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [table],
    ).then(([rows]) => {
      if (rows.length === 0) throw new Error(`No table named ${table}`);
      const extra = (r: mysql.RowDataPacket): string => String(r.extra);
      return {
        required: rows
          .filter((r) => r.nullable === 'NO' && r.columnDefault === null && !/auto_increment|DEFAULT_GENERATED/i.test(extra(r)))
          .map((r) => ({
            name: String(r.name),
            dataType: String(r.dataType),
            columnType: String(r.columnType),
          })),
        autoIncrement: rows.find((r) => /auto_increment/i.test(extra(r)))?.name ?? null,
      };
    });
    tableInfoCache.set(table, info);
  }
  return info;
}

/**
 * A placeholder value for a required column that no test cares about.
 * @param column The column to fill.
 * @returns A value of the column's type, unique within the run.
 * @throws For a column type no table needs yet; extend this when one does.
 */
function placeholderValue(column: RequiredColumn): unknown {
  const n = nextValue++;
  if (NUMERIC_TYPES.has(column.dataType)) return n;
  // Short enough for every string column in the schema (the narrowest is VARCHAR(20)).
  if (STRING_TYPES.has(column.dataType)) return `v${n}`;
  if (column.dataType === 'enum') return /^enum\('((?:[^']|'')*)'/.exec(column.columnType)![1]!.replaceAll("''", "'");
  if (column.dataType === 'datetime') return '2030-01-01 00:00:00';
  if (column.dataType === 'varbinary') return Buffer.from(`v${n}`);
  throw new Error(`insertRow can't fill ${column.name}: no placeholder for ${column.dataType} columns`);
}

/**
 * Inserts a row into `table`, filling every required column it isn't given: a foreign key with a
 * new parent row (inserted the same way), anything else with a placeholder.
 * @param table Table to insert into.
 * @param values Column values to use as given; the rest are filled in.
 * @returns Every value inserted, plus the auto-increment column's new value if the table has one.
 */
export async function insertRow(table: string, values: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const [info, keys] = await Promise.all([tableInfo(table), foreignKeys()]);
  const row = { ...values };
  for (const column of info.required) {
    if (column.name in row) continue;
    const fk = keys.find((k) => k.table === table && k.column === column.name);
    row[column.name] = fk ? (await insertRow(fk.referencedTable))[fk.referencedColumn] : placeholderValue(column);
  }
  const names = Object.keys(row);
  const [result] = await getPool().query<mysql.ResultSetHeader>(
    `INSERT INTO \`${table}\` (${names.map((c) => `\`${c}\``).join(', ')}) VALUES (?)`,
    [names.map((c) => row[c])],
  );
  if (info.autoIncrement && !(info.autoIncrement in row)) row[info.autoIncrement] = result.insertId;
  return row;
}
