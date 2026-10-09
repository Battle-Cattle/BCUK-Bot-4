import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// schema.sql (fresh installs), migrations/ (upgrades) and DATABASE-SCHEMA.md (the reference)
// all describe the same database by hand. These tests catch one of them falling behind.
const repoRoot = path.join(__dirname, '../..');
const migrationsDir = path.join(repoRoot, 'migrations');

const schemaSql = fs.readFileSync(path.join(repoRoot, 'schema.sql'), 'utf8');
const schemaDoc = fs.readFileSync(path.join(repoRoot, 'DATABASE-SCHEMA.md'), 'utf8');
const migrations = fs.readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .map((name) => ({ name, sql: stripSqlComments(fs.readFileSync(path.join(migrationsDir, name), 'utf8')) }));

function stripSqlComments(sql: string): string {
  return sql.replace(/^\s*--.*$/gm, '');
}

function matchAll(sql: string, pattern: RegExp): string[] {
  return [...sql.matchAll(pattern)].map((m) => m[1]!.toLowerCase());
}

const CREATE_TABLE = /CREATE TABLE (?:IF NOT EXISTS )?`?(\w+)`?\s*\(/gi;

function schemaTables(): Set<string> {
  return new Set(matchAll(stripSqlComments(schemaSql), CREATE_TABLE));
}

/** Column names declared in `table`'s CREATE TABLE block in schema.sql. */
function schemaColumns(table: string): Set<string> {
  const block = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?\`?${table}\`?\\s*\\(([\\s\\S]*?)\\n\\)`, 'i')
    .exec(stripSqlComments(schemaSql));
  expect(block, `schema.sql has no CREATE TABLE for ${table}`).not.toBeNull();
  return new Set(matchAll(block![1]!, /^\s*`?(\w+)`?\s+[A-Z]/gim));
}

/**
 * `table.column` pairs a migration applies `action` to (ADD or DROP), attributing each one to
 * the nearest preceding `ALTER TABLE`. Works for statements built as prepared-statement strings too.
 */
function alteredColumns(action: 'ADD' | 'DROP'): Set<string> {
  const pairs = new Set<string>();
  for (const { sql } of migrations) {
    const pattern = new RegExp(`ALTER TABLE \`?(\\w+)\`?|${action} COLUMN (?:IF (?:NOT )?EXISTS )?\`?(\\w+)\`?`, 'gi');
    let table: string | undefined;
    for (const m of sql.matchAll(pattern)) {
      if (m[1]) table = m[1].toLowerCase();
      else if (table) pairs.add(`${table}.${m[2]!.toLowerCase()}`);
    }
  }
  return pairs;
}

describe('schema.sql vs migrations/', () => {
  it('creates every table a migration creates (unless a later migration drops it)', () => {
    const dropped = new Set(migrations.flatMap(({ sql }) => matchAll(sql, /DROP TABLE (?:IF EXISTS )?`?(\w+)`?/gi)));
    const expected = new Set(migrations.flatMap(({ sql }) => matchAll(sql, CREATE_TABLE)).filter((t) => !dropped.has(t)));
    const tables = schemaTables();
    expect([...expected].filter((t) => !tables.has(t))).toEqual([]);
  });

  it('declares every column a migration adds (unless a later migration drops it)', () => {
    const dropped = alteredColumns('DROP');
    const missing = [...alteredColumns('ADD')]
      .filter((pair) => !dropped.has(pair))
      .filter((pair) => {
        const [table, column] = pair.split('.') as [string, string];
        return !schemaColumns(table).has(column);
      });
    expect(missing).toEqual([]);
  });
});

describe('DATABASE-SCHEMA.md vs schema.sql', () => {
  // Sections are `## \`table\``; `sessions` is documented but created by express-mysql-session.
  const documented = new Set(matchAll(schemaDoc, /^## `(\w+)`/gm));
  documented.delete('sessions');

  it('documents every table in schema.sql', () => {
    expect([...schemaTables()].filter((t) => !documented.has(t))).toEqual([]);
  });

  it('only documents tables that exist in schema.sql', () => {
    const tables = schemaTables();
    expect([...documented].filter((t) => !tables.has(t))).toEqual([]);
  });
});
