import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Reading and validating migration files. Kept free of DB/config imports so tests can use it
// without a configured environment.

/** `migrations/` at the repo root; the same relative path from both `src/db` and `dist/db`. */
export const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

/** `NNNN_snake_description.sql`: a four-digit sequence number, then a lowercase description. */
export const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** A migration file read from disk. */
export interface MigrationFile {
  /** File name without `.sql`, e.g. `0002_add_widget`; the key stored in `schema_migrations`. */
  version: string;
  sql: string;
  /** SHA-256 of the file (line endings normalised), to catch edits after it was applied. */
  checksum: string;
}

/**
 * Validates and orders migration file names. Files that don't end in `.sql` are ignored.
 * @param names File names from the migrations directory.
 * @returns The `.sql` names sorted by sequence number.
 * @throws If a `.sql` name doesn't match {@link MIGRATION_FILE_PATTERN}, or two share a number.
 */
export function sortMigrationFileNames(names: readonly string[]): string[] {
  const byNumber = new Map<string, string>();
  for (const name of names.filter((n) => n.endsWith('.sql'))) {
    const match = MIGRATION_FILE_PATTERN.exec(name);
    if (!match) throw new Error(`Migration file "${name}" doesn't match NNNN_description.sql`);
    const existing = byNumber.get(match[1]!);
    if (existing) throw new Error(`Migrations "${existing}" and "${name}" share the number ${match[1]}`);
    byNumber.set(match[1]!, name);
  }
  return [...byNumber.keys()].sort().map((n) => byNumber.get(n)!);
}

/**
 * Hashes a migration's SQL, ignoring CRLF vs LF so a Windows checkout hashes the same.
 * @param sql File contents.
 * @returns Lowercase hex SHA-256.
 */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Lists the tables a migration creates, ignoring `--` comment lines.
 * @param sql Migration SQL.
 * @returns Lowercased table names, in file order.
 */
export function createdTables(sql: string): string[] {
  const code = sql.replace(/^\s*--.*$/gm, '');
  return [...code.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?`?(\w+)`?/gi)].map((m) => m[1]!.toLowerCase());
}

/**
 * Reads every migration in `dir`, in order.
 * @param dir Directory holding the migration files.
 * @returns The migrations, sorted by sequence number.
 */
export function loadMigrationFiles(dir: string): MigrationFile[] {
  return sortMigrationFileNames(fs.readdirSync(dir)).map((name) => {
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    return { version: name.slice(0, -'.sql'.length), sql, checksum: migrationChecksum(sql) };
  });
}
