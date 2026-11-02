import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { schemaFromMigrations } from '../test-utils/migrationSchema';

const REPO_ROOT = path.resolve(__dirname, '../..');

// Documented in DATABASE-SCHEMA.md but created outside migrations/: the migration runner creates
// `schema_migrations` itself.
const DOC_ONLY_TABLES = new Set(['schema_migrations']);

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
  const sqlTables = new Map([...schemaFromMigrations()].map(([name, { columns }]) => [name, columns]));
  const docTables = tablesInSchemaDoc();

  it('reads the schema from the migrations, and the doc lists the same number of tables', () => {
    expect(sqlTables.size).toBeGreaterThan(20);
    expect(docTables.size).toBe(sqlTables.size + DOC_ONLY_TABLES.size);
  });

  it('documents exactly the tables the migrations create', () => {
    const undocumented = [...sqlTables.keys()].filter((t) => !docTables.has(t));
    const notInSql = [...docTables.keys()].filter((t) => !sqlTables.has(t) && !DOC_ONLY_TABLES.has(t));
    expect({ undocumented, notInSql }).toEqual({ undocumented: [], notInSql: [] });
  });

  it('lists the same columns as the migrations for every table', () => {
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
