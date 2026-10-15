import mysql from 'mysql2/promise';
import { connectionOptions } from './pool';
import { createdTables, loadMigrationFiles, MIGRATIONS_DIR, type MigrationFile } from './migrationFiles';
import { createLogger } from '../shared/logger';

const log = createLogger('Migrations');

/** The first migration: the full schema as it stood when automated migrations were introduced. */
export const BASELINE_VERSION = '0001_baseline';

/** Named lock held while migrating, so two processes starting at once can't both apply a file. */
const LOCK_NAME = 'bcuk_bot_migrations';
const LOCK_TIMEOUT_SECONDS = 30;

/** A table every install has had since long before the baseline; its presence marks a pre-existing database. */
const EXISTING_INSTALL_MARKER_TABLE = 'user';

/**
 * Takes the migration lock, waiting up to {@link LOCK_TIMEOUT_SECONDS}.
 * @param conn Connection to hold the lock on.
 * @throws If the lock isn't acquired in time.
 */
async function acquireLock(conn: mysql.Connection): Promise<void> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
  if (Number(rows[0]?.acquired) !== 1) {
    throw new Error(`Couldn't acquire the "${LOCK_NAME}" lock within ${LOCK_TIMEOUT_SECONDS}s — is another instance migrating?`);
  }
}

/**
 * Creates the `schema_migrations` tracking table if needed and reads what it records.
 * @param conn Connection to query on.
 * @returns Version → stored checksum for every applied migration.
 */
async function readApplied(conn: mysql.Connection): Promise<Map<string, string>> {
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    VARCHAR(255) NOT NULL,
    checksum   CHAR(64)     NOT NULL,
    applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (version)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT version, checksum FROM schema_migrations');
  return new Map(rows.map((r) => [String(r.version), String(r.checksum)]));
}

/**
 * Records a migration as applied.
 * @param conn Connection to write on.
 * @param migration The migration to record.
 */
async function recordApplied(conn: mysql.Connection, migration: MigrationFile): Promise<void> {
  await conn.query('INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)', [migration.version, migration.checksum]);
}

/**
 * One-time adoption of a database that predates `schema_migrations`: if nothing is recorded yet
 * but the database already has tables, records the baseline as applied without running it, after
 * checking every table it creates is there. An empty database is left alone so the baseline runs.
 * @param conn Connection to query on.
 * @param applied What `schema_migrations` records; updated in place when the baseline is adopted.
 * @param baseline The baseline migration file.
 * @throws If the database has tables but is missing some the baseline creates.
 */
async function adoptExistingDatabase(conn: mysql.Connection, applied: Map<string, string>, baseline: MigrationFile): Promise<void> {
  if (applied.size > 0) return;
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    'SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema = DATABASE()',
  );
  const existing = new Set(rows.map((r) => String(r.name).toLowerCase()));
  if (!existing.has(EXISTING_INSTALL_MARKER_TABLE)) return;
  const missing = createdTables(baseline.sql).filter((t) => !existing.has(t));
  if (missing.length > 0) {
    throw new Error(`Existing database is missing baseline tables (${missing.join(', ')}); bring it up to date by hand before adopting migrations`);
  }
  await recordApplied(conn, baseline);
  applied.set(baseline.version, baseline.checksum);
  log.info(`Existing database adopted: recorded ${baseline.version} as applied without running it`);
}

/**
 * Checks every recorded migration still has its file, unchanged.
 * @param applied Version → stored checksum.
 * @param files Migration files on disk.
 * @throws If a recorded migration's file is missing or was edited after it was applied.
 */
function verifyApplied(applied: Map<string, string>, files: readonly MigrationFile[]): void {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  for (const [version, checksum] of applied) {
    const file = byVersion.get(version);
    if (!file) throw new Error(`Migration ${version} is recorded as applied but its file is missing`);
    if (file.checksum !== checksum) throw new Error(`Migration ${version} was edited after it was applied — add a new migration instead`);
  }
}

/**
 * Runs each migration not yet applied, in order, recording each one as it succeeds. MySQL commits
 * DDL implicitly, so a failure part-way through a file can leave that file's earlier statements applied.
 * @param conn Connection opened with `multipleStatements`.
 * @param applied Versions already applied.
 * @param files Migration files on disk, in order.
 * @throws The first failure, naming the migration.
 */
async function applyPending(conn: mysql.Connection, applied: Map<string, string>, files: readonly MigrationFile[]): Promise<void> {
  const pending = files.filter((f) => !applied.has(f.version));
  if (pending.length === 0) {
    log.info('Database schema is up to date');
    return;
  }
  for (const migration of pending) {
    log.info(`Applying migration ${migration.version}...`);
    try {
      await conn.query(migration.sql);
    } catch (err) {
      throw new Error(`Migration ${migration.version} failed: ${(err as Error).message}`, { cause: err });
    }
    await recordApplied(conn, migration);
  }
  log.info(`Applied ${pending.length} migration(s)`);
}

/**
 * Brings the database schema up to date: applies every file in `dir` not yet recorded in
 * `schema_migrations`, in order, on a dedicated connection holding a named lock. A database that
 * predates migrations has the baseline recorded instead of run (see {@link adoptExistingDatabase}).
 * @param dir Directory holding the migration files; defaults to the repo's `migrations/`.
 * @throws If the lock can't be taken, a file is misnamed, an applied file changed, or a migration fails.
 */
export async function runMigrations(dir: string = MIGRATIONS_DIR): Promise<void> {
  const files = loadMigrationFiles(dir);
  const baseline = files.find((f) => f.version === BASELINE_VERSION);
  if (!baseline) throw new Error(`Baseline migration ${BASELINE_VERSION}.sql not found in ${dir}`);

  const conn = await mysql.createConnection({ ...connectionOptions(), multipleStatements: true });
  try {
    await acquireLock(conn);
    try {
      const applied = await readApplied(conn);
      await adoptExistingDatabase(conn, applied, baseline);
      verifyApplied(applied, files);
      await applyPending(conn, applied, files);
    } finally {
      await conn.query('DO RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    }
  } finally {
    await conn.end().catch(() => {});
  }
}
