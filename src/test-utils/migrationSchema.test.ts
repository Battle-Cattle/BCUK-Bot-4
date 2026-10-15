import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schemaFromMigrations } from './migrationSchema';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-schema-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes `files` (name → SQL) into the temp migrations directory. */
function writeMigrations(files: Record<string, string>): void {
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
}

/** Columns per table, as plain arrays for easy comparison. */
function columnsOf(dir: string): Record<string, string[]> {
  return Object.fromEntries([...schemaFromMigrations(dir)].map(([t, { columns }]) => [t, [...columns]]));
}

describe('schemaFromMigrations', () => {
  it('reads tables and columns from CREATE TABLE, skipping constraints, wrapped lines and comments', () => {
    writeMigrations({
      '0001_baseline.sql': `-- header; with a semicolon
CREATE TABLE IF NOT EXISTS \`Widget\` (
  id    INT NOT NULL AUTO_INCREMENT,  -- the id
  label VARCHAR(20)
        NOT NULL DEFAULT 'none',
  PRIMARY KEY (id),
  KEY idx_label (label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO widget (label) VALUES ('x');
`,
    });
    expect(columnsOf(dir)).toEqual({ widget: ['id', 'label'] });
  });

  it('replays later ALTER TABLE column changes and DROP TABLE, in order', () => {
    writeMigrations({
      '0001_baseline.sql': 'CREATE TABLE a (\n  id INT,\n  old_name INT,\n  gone INT\n);\nCREATE TABLE b (\n  id INT\n);\n',
      '0002_alter.sql': 'ALTER TABLE a ADD COLUMN added INT, DROP COLUMN gone;\nALTER TABLE a RENAME COLUMN old_name TO new_name;\nDROP TABLE IF EXISTS b;\n',
      '0003_change.sql': 'ALTER TABLE `a` CHANGE COLUMN added renamed BIGINT;\nALTER TABLE missing ADD COLUMN x INT;\n',
    });
    expect(columnsOf(dir)).toEqual({ a: ['id', 'new_name', 'renamed'] });
  });

  it('appends ALTER clauses to the table definition', () => {
    writeMigrations({
      '0001_baseline.sql': 'CREATE TABLE a (\n  id INT\n);\n',
      '0002_fk.sql': 'ALTER TABLE a ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES `user`(discord_id);\n',
    });
    expect(schemaFromMigrations(dir).get('a')?.definition).toContain('FOREIGN KEY (id) REFERENCES `user`(discord_id)');
  });

  it('reads the repo migrations by default', () => {
    expect(schemaFromMigrations().get('user')?.columns.has('discord_id')).toBe(true);
  });
});
