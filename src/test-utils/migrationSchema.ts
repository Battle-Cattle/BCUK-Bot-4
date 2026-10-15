// migrationFiles only reads files on disk (no DB writes to wrap), and going through db.ts would
// load the env-dependent config this test helper must run without.
// eslint-disable-next-line no-restricted-imports -- see above
import { loadMigrationFiles, MIGRATIONS_DIR } from '../db/migrationFiles';

/** A table as the migrations leave it. */
export interface SchemaTable {
  /** Column names, in the order they were declared or added. */
  columns: Set<string>;
  /**
   * The `CREATE TABLE` body followed by every later `ALTER TABLE` clause on it, for tests that
   * scan a table's definition (e.g. its foreign keys).
   */
  definition: string;
}

// Words that start a CREATE TABLE body line without naming a column: table constraints, and
// the second line of a column definition that wraps (e.g. `NOT NULL DEFAULT 'none'`).
const NON_COLUMN_WORDS = new Set([
  'PRIMARY', 'UNIQUE', 'KEY', 'INDEX', 'CONSTRAINT', 'FOREIGN', 'CHECK', 'FULLTEXT', 'NOT', 'NULL', 'DEFAULT',
]);

/**
 * Splits migration SQL into statements, dropping `--` comments. Only plain statements are seen:
 * DDL built as a string for `PREPARE` is invisible to it.
 * @param sql Migration file contents.
 * @returns Trimmed, non-empty statements.
 */
function splitStatements(sql: string): string[] {
  return sql.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
}

/**
 * Column names declared in a CREATE TABLE body, one per line.
 * @param body Text between the statement's outer parentheses.
 * @returns The column names.
 */
function bodyColumns(body: string): Set<string> {
  const columns = new Set<string>();
  for (const line of body.split('\n')) {
    const firstWord = /^`?(\w+)`?\s+\S/.exec(line.trim())?.[1];
    if (firstWord && !NON_COLUMN_WORDS.has(firstWord.toUpperCase())) columns.add(firstWord);
  }
  return columns;
}

/**
 * Applies one ALTER TABLE's column changes (`ADD`/`DROP`/`RENAME`/`CHANGE COLUMN`) to `table`
 * and appends the clause to its definition.
 * @param table The table being altered.
 * @param clause Everything after `ALTER TABLE name`.
 */
function applyAlter(table: SchemaTable, clause: string): void {
  table.definition += `\n${clause}`;
  const pattern = /(ADD|DROP|RENAME|CHANGE) COLUMN (?:IF (?:NOT )?EXISTS )?`?(\w+)`?(?:\s+TO)?(?:\s+`?(\w+)`?)?/gi;
  for (const [, action, column, renamed] of clause.matchAll(pattern)) {
    const verb = action!.toUpperCase();
    if (verb === 'ADD') table.columns.add(column!);
    else table.columns.delete(column!);
    if ((verb === 'RENAME' || verb === 'CHANGE') && renamed) table.columns.add(renamed);
  }
}

/**
 * Applies one statement to the schema being built: CREATE TABLE, DROP TABLE and ALTER TABLE
 * column changes. Anything else (data changes, SET, PREPARE…) is ignored.
 * @param tables The schema so far, updated in place.
 * @param statement One SQL statement.
 */
function applyStatement(tables: Map<string, SchemaTable>, statement: string): void {
  const create = /^CREATE TABLE (?:IF NOT EXISTS )?`?(\w+)`?\s*\(([\s\S]*)\)[^)]*$/i.exec(statement);
  if (create) {
    tables.set(create[1]!.toLowerCase(), { columns: bodyColumns(create[2]!), definition: create[2]! });
    return;
  }
  const drop = /^DROP TABLE (?:IF EXISTS )?`?(\w+)`?/i.exec(statement);
  if (drop) {
    tables.delete(drop[1]!.toLowerCase());
    return;
  }
  const alter = /^ALTER TABLE `?(\w+)`?\s+([\s\S]*)$/i.exec(statement);
  const table = alter && tables.get(alter[1]!.toLowerCase());
  if (table) applyAlter(table, alter[2]!);
}

/**
 * The database schema the migrations produce, by replaying their CREATE/DROP/ALTER TABLE
 * statements in order. Used by tests that check the docs and code against the real schema.
 * @param dir Migrations directory; defaults to the repo's `migrations/`.
 * @returns Lowercased table name → its columns and definition.
 */
export function schemaFromMigrations(dir: string = MIGRATIONS_DIR): Map<string, SchemaTable> {
  const tables = new Map<string, SchemaTable>();
  for (const { sql } of loadMigrationFiles(dir)) {
    for (const statement of splitStatements(sql)) applyStatement(tables, statement);
  }
  return tables;
}
