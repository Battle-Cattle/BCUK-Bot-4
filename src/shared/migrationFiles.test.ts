import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  sortMigrationFileNames, migrationChecksum, createdTables, loadMigrationFiles, MIGRATIONS_DIR, MIGRATION_FILE_PATTERN,
} from './migrationFiles';

describe('sortMigrationFileNames', () => {
  it('orders by sequence number and ignores non-.sql files', () => {
    expect(sortMigrationFileNames(['0002_b.sql', 'README.md', '0010_c.sql', '0001_a.sql']))
      .toEqual(['0001_a.sql', '0002_b.sql', '0010_c.sql']);
  });

  it.each(['1_short.sql', '0002-dash.sql', '0002_Upper.sql', 'baseline.sql'])('rejects the badly named %s', (name) => {
    expect(() => sortMigrationFileNames([name])).toThrow(/doesn't match/);
  });

  it('rejects two files sharing a number', () => {
    expect(() => sortMigrationFileNames(['0002_a.sql', '0002_b.sql'])).toThrow(/share the number 0002/);
  });
});

describe('migrationChecksum', () => {
  it('hashes CRLF and LF line endings the same', () => {
    expect(migrationChecksum('a;\r\nb;\r\n')).toBe(migrationChecksum('a;\nb;\n'));
  });

  it('differs when the SQL differs', () => {
    expect(migrationChecksum('a;')).not.toBe(migrationChecksum('b;'));
  });
});

describe('createdTables', () => {
  it('lists created tables in order, lowercased, ignoring comment lines', () => {
    expect(createdTables('-- CREATE TABLE ignored (\nCREATE TABLE `User` (\nCREATE TABLE IF NOT EXISTS guild (')).toEqual(['user', 'guild']);
  });
});

describe('the repo migrations directory', () => {
  it('only holds correctly named migrations, starting with the baseline', () => {
    const names = fs.readdirSync(MIGRATIONS_DIR);
    expect(names.filter((n) => !MIGRATION_FILE_PATTERN.test(n))).toEqual([]);
    expect(loadMigrationFiles(MIGRATIONS_DIR)[0]?.version).toBe('0001_baseline');
  });
});
