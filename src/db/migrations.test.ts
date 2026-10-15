import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockLogger } from '../test-utils/loggerMock';

const createConnection = vi.fn();
vi.mock('mysql2/promise', () => ({ default: { createConnection: (...args: unknown[]) => createConnection(...args) } }));
vi.mock('../shared/config', () => ({
  DB_HOST: 'test-host',
  DB_PORT: 1234,
  DB_USER: 'test-user',
  DB_PASSWORD: 'test-password',
  DB_NAME: 'test-db',
}));
vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

import { runMigrations } from './migrations';
import { migrationChecksum } from './migrationFiles';

const BASELINE_SQL = 'CREATE TABLE IF NOT EXISTS `user` (id INT);\nCREATE TABLE IF NOT EXISTS guild (id INT);\n';

interface FakeDb {
  applied: Map<string, string>;
  tables: string[];
  lockAcquired: number;
  failOn?: string;
}

/** A mock connection backed by a tiny in-memory model of the tables the runner reads and writes. */
function makeConn(db: FakeDb) {
  const executed: string[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: db.lockAcquired }], []];
    if (sql.startsWith('DO RELEASE_LOCK')) return [[], []];
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) return [[], []];
    if (sql.startsWith('SELECT version, checksum')) {
      return [[...db.applied].map(([version, checksum]) => ({ version, checksum })), []];
    }
    if (sql.includes('information_schema.tables')) return [db.tables.map((name) => ({ name })), []];
    if (sql.startsWith('INSERT INTO schema_migrations')) {
      const [version, checksum] = params as [string, string];
      db.applied.set(version, checksum);
      return [{ affectedRows: 1 }, []];
    }
    if (db.failOn && sql.includes(db.failOn)) throw new Error('You have an error in your SQL syntax');
    executed.push(sql);
    return [[], []];
  });
  return { query, end: vi.fn().mockResolvedValue(undefined), executed };
}

let dir: string;

/** Writes `files` (name → SQL) into the temp migrations directory. */
function writeMigrations(files: Record<string, string>): void {
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
}

beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('runMigrations', () => {
  it('opens a dedicated multi-statement connection with the shared settings', async () => {
    writeMigrations({ '0001_baseline.sql': BASELINE_SQL });
    createConnection.mockResolvedValue(makeConn({ applied: new Map(), tables: [], lockAcquired: 1 }));

    await runMigrations(dir);

    expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({
      host: 'test-host', database: 'test-db', bigNumberStrings: true, multipleStatements: true,
    }));
  });

  it('runs every migration, in order, against an empty database and records each', async () => {
    writeMigrations({ '0001_baseline.sql': BASELINE_SQL, '0002_add_x.sql': 'ALTER TABLE guild ADD COLUMN x INT;' });
    const db: FakeDb = { applied: new Map(), tables: [], lockAcquired: 1 };
    const conn = makeConn(db);
    createConnection.mockResolvedValue(conn);

    await runMigrations(dir);

    expect(conn.executed).toEqual([BASELINE_SQL, 'ALTER TABLE guild ADD COLUMN x INT;']);
    expect([...db.applied.keys()]).toEqual(['0001_baseline', '0002_add_x']);
    expect(db.applied.get('0001_baseline')).toBe(migrationChecksum(BASELINE_SQL));
  });

  it('only runs migrations not yet applied', async () => {
    writeMigrations({ '0001_baseline.sql': BASELINE_SQL, '0002_add_x.sql': 'ALTER TABLE guild ADD COLUMN x INT;' });
    const db: FakeDb = { applied: new Map([['0001_baseline', migrationChecksum(BASELINE_SQL)]]), tables: ['user', 'guild'], lockAcquired: 1 };
    const conn = makeConn(db);
    createConnection.mockResolvedValue(conn);

    await runMigrations(dir);

    expect(conn.executed).toEqual(['ALTER TABLE guild ADD COLUMN x INT;']);
  });

  it('does nothing when everything is applied', async () => {
    writeMigrations({ '0001_baseline.sql': BASELINE_SQL });
    const conn = makeConn({ applied: new Map([['0001_baseline', migrationChecksum(BASELINE_SQL)]]), tables: ['user', 'guild'], lockAcquired: 1 });
    createConnection.mockResolvedValue(conn);

    await runMigrations(dir);

    expect(conn.executed).toEqual([]);
  });

  it('adopts a pre-existing database by recording the baseline without running it, then runs later migrations', async () => {
    writeMigrations({ '0001_baseline.sql': BASELINE_SQL, '0002_add_x.sql': 'ALTER TABLE guild ADD COLUMN x INT;' });
    const db: FakeDb = { applied: new Map(), tables: ['user', 'guild', 'sessions'], lockAcquired: 1 };
    const conn = makeConn(db);
    createConnection.mockResolvedValue(conn);

    await runMigrations(dir);

    expect(conn.executed).toEqual(['ALTER TABLE guild ADD COLUMN x INT;']);
    expect([...db.applied.keys()]).toEqual(['0001_baseline', '0002_add_x']);
  });

  it('refuses to adopt a pre-existing database missing baseline tables', async () => {
    writeMigrations({ '0001_baseline.sql': BASELINE_SQL });
    const db: FakeDb = { applied: new Map(), tables: ['user'], lockAcquired: 1 };
    const conn = makeConn(db);
    createConnection.mockResolvedValue(conn);

    await expect(runMigrations(dir)).rejects.toThrow(/missing baseline tables \(guild\)\. It predates the baseline/);
    expect(db.applied.size).toBe(0);
    expect(conn.executed).toEqual([]);
  });

  it('fails when an applied migration was edited', async () => {
    writeMigrations({ '0001_baseline.sql': BASELINE_SQL });
    createConnection.mockResolvedValue(makeConn({ applied: new Map([['0001_baseline', 'stale']]), tables: ['user', 'guild'], lockAcquired: 1 }));

    await expect(runMigrations(dir)).rejects.toThrow(/0001_baseline was edited after it was applied/);
  });

  it('fails when an applied migration file is missing', async () => {
    writeMigrations({ '0001_baseline.sql': BASELINE_SQL });
    createConnection.mockResolvedValue(makeConn({
      applied: new Map([['0001_baseline', migrationChecksum(BASELINE_SQL)], ['0002_gone', 'x']]), tables: ['user', 'guild'], lockAcquired: 1,
    }));

    await expect(runMigrations(dir)).rejects.toThrow(/0002_gone is recorded as applied but its file is missing/);
  });

  it('fails without connecting when there is no baseline file', async () => {
    writeMigrations({ '0002_add_x.sql': 'SELECT 1;' });

    await expect(runMigrations(dir)).rejects.toThrow(/Baseline migration 0001_baseline.sql not found/);
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('stops at a failing migration, naming it, keeps earlier ones recorded, and releases the lock and connection', async () => {
    writeMigrations({
      '0001_baseline.sql': BASELINE_SQL,
      '0002_ok.sql': 'ALTER TABLE guild ADD COLUMN ok INT;',
      '0003_bad.sql': 'ALTER TABLE guild BROKEN;',
      '0004_later.sql': 'ALTER TABLE guild ADD COLUMN later INT;',
    });
    const db: FakeDb = { applied: new Map([['0001_baseline', migrationChecksum(BASELINE_SQL)]]), tables: ['user', 'guild'], lockAcquired: 1, failOn: 'BROKEN' };
    const conn = makeConn(db);
    createConnection.mockResolvedValue(conn);

    await expect(runMigrations(dir)).rejects.toThrow(/Migration 0003_bad failed: You have an error in your SQL syntax/);
    expect([...db.applied.keys()]).toEqual(['0001_baseline', '0002_ok']);
    expect(conn.executed).not.toContain('ALTER TABLE guild ADD COLUMN later INT;');
    expect(conn.query).toHaveBeenCalledWith('DO RELEASE_LOCK(?)', ['bcuk_bot_migrations']);
    expect(conn.end).toHaveBeenCalledOnce();
  });

  it('fails when the lock is held elsewhere, and still closes the connection', async () => {
    writeMigrations({ '0001_baseline.sql': BASELINE_SQL });
    const conn = makeConn({ applied: new Map(), tables: [], lockAcquired: 0 });
    createConnection.mockResolvedValue(conn);

    await expect(runMigrations(dir)).rejects.toThrow(/Couldn't acquire the "bcuk_bot_migrations" lock/);
    expect(conn.executed).toEqual([]);
    expect(conn.end).toHaveBeenCalledOnce();
  });
});
