import { describe, it, expect } from 'vitest';
import type mysql from 'mysql2/promise';
import { getPool } from './pool';
import { runMigrations } from './migrations';
import { createdTables, loadMigrationFiles, MIGRATIONS_DIR } from '../shared/migrationFiles';
import { workerDatabase } from '../test-utils/realDb';

// The real migration runner against a real MySQL (npm run test:db): every file in migrations/
// applies cleanly to an empty database, end to end.

describe('migrations (real MySQL)', () => {
  it('applies every migration to an empty database and records each one', async () => {
    await workerDatabase().recreateEmpty();

    await runMigrations();

    const files = loadMigrationFiles(MIGRATIONS_DIR);
    const [recorded] = await getPool().query<mysql.RowDataPacket[]>('SELECT version, checksum FROM schema_migrations ORDER BY version');
    expect(recorded.map((r) => ({ version: r.version, checksum: r.checksum })))
      .toEqual(files.map((f) => ({ version: f.version, checksum: f.checksum })));

    const [tables] = await getPool().query<mysql.RowDataPacket[]>(
      'SELECT LOWER(TABLE_NAME) AS name FROM information_schema.tables WHERE table_schema = DATABASE()',
    );
    const existing = new Set(tables.map((t) => String(t.name)));
    expect(files.flatMap((f) => createdTables(f.sql)).filter((t) => !existing.has(t))).toEqual([]);
  });

  it('is a no-op on an up-to-date database', async () => {
    const [before] = await getPool().query<mysql.RowDataPacket[]>('SELECT version, applied_at FROM schema_migrations ORDER BY version');

    await runMigrations();

    const [after] = await getPool().query<mysql.RowDataPacket[]>('SELECT version, applied_at FROM schema_migrations ORDER BY version');
    expect(after).toEqual(before);
  });
});
