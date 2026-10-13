import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

// Documented in DATABASE-SCHEMA.md but deliberately absent from schema.sql:
// express-mysql-session creates `sessions` itself on first run (see schema.sql's header).
const DOC_ONLY_TABLES = new Set(['sessions']);

// Words that start a schema.sql table-body line without naming a column: table constraints,
// and the second line of a column definition that wraps (e.g. `NOT NULL DEFAULT 'none'`).
const NON_COLUMN_WORDS = new Set([
  'PRIMARY', 'UNIQUE', 'KEY', 'INDEX', 'CONSTRAINT', 'FOREIGN', 'CHECK', 'FULLTEXT', 'NOT', 'NULL', 'DEFAULT',
]);

/** Table name → column names, from every `CREATE TABLE` in schema.sql. */
function tablesInSchemaSql(): Map<string, Set<string>> {
  const sql = readFileSync(path.join(REPO_ROOT, 'schema.sql'), 'utf8');
  const tables = new Map<string, Set<string>>();
  // Ends at the statement's `;`, whether or not table options like ENGINE= come before it.
  for (const [, name, body] of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?`?(\w+)`?\s*\(([\s\S]*?)\)\s*(?:ENGINE\b[^;]*)?;/g)) {
    const columns = new Set<string>();
    for (const rawLine of body!.split('\n')) {
      const firstWord = /^`?(\w+)`?\s+\S/.exec(rawLine.replace(/--.*/, '').trim())?.[1];
      if (firstWord && !NON_COLUMN_WORDS.has(firstWord.toUpperCase())) columns.add(firstWord);
    }
    tables.set(name!, columns);
  }
  return tables;
}

/**
 * Table name → column names, from each "## `table`" section's column table in
 * DATABASE-SCHEMA.md. A row naming a numbered range (`value2020`-`value2025`) stands for every
 * column in it.
 */
function tablesInSchemaDoc(): Map<string, Set<string>> {
  const doc = readFileSync(path.join(REPO_ROOT, 'DATABASE-SCHEMA.md'), 'utf8');
  const tables = new Map<string, Set<string>>();
  for (const section of doc.split(/^## /m).slice(1)) {
    const name = /^`(\w+)`/.exec(section)?.[1];
    if (!name) continue;
    const columns = new Set<string>();
    for (const [, first, rangeStem, rangeEnd] of section.matchAll(/^\| `(\w+)`(?:-`([a-z_]+)(\d+)`)? \|/gm)) {
      const start = rangeStem ? Number(/(\d+)$/.exec(first!)?.[1]) : NaN;
      if (rangeStem && Number.isInteger(start)) {
        for (let n = start; n <= Number(rangeEnd); n++) columns.add(`${rangeStem}${n}`);
      } else {
        columns.add(first!);
      }
    }
    tables.set(name, columns);
  }
  return tables;
}

describe('DATABASE-SCHEMA.md', () => {
  const sqlTables = tablesInSchemaSql();
  const docTables = tablesInSchemaDoc();

  it('parses every CREATE TABLE in schema.sql, and the doc lists the same number of tables', () => {
    const createStatements = readFileSync(path.join(REPO_ROOT, 'schema.sql'), 'utf8').match(/^\s*CREATE TABLE\b/gim) ?? [];
    expect(sqlTables.size).toBeGreaterThan(20);
    expect(sqlTables.size).toBe(createStatements.length);
    expect(docTables.size).toBe(sqlTables.size + DOC_ONLY_TABLES.size);
  });

  it('documents exactly the tables schema.sql creates', () => {
    const undocumented = [...sqlTables.keys()].filter((t) => !docTables.has(t));
    const notInSql = [...docTables.keys()].filter((t) => !sqlTables.has(t) && !DOC_ONLY_TABLES.has(t));
    expect({ undocumented, notInSql }).toEqual({ undocumented: [], notInSql: [] });
  });

  it("lists the same columns as schema.sql for every table", () => {
    const mismatches: Record<string, { missingFromDoc: string[]; notInSql: string[] }> = {};
    for (const [table, sqlColumns] of sqlTables) {
      const docColumns = docTables.get(table) ?? new Set<string>();
      const missingFromDoc = [...sqlColumns].filter((c) => !docColumns.has(c));
      const notInSql = [...docColumns].filter((c) => !sqlColumns.has(c));
      if (missingFromDoc.length || notInSql.length) mismatches[table] = { missingFromDoc, notInSql };
    }
    expect(mismatches).toEqual({});
  });
});
