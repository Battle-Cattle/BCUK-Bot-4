import { describe, it, expect } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { SCRIPT_TEST_TIMEOUT_MS, notLinux, read, sandbox, useSandbox, write } from './test-utils/deploySandbox';

/** End-to-end tests for scripts/restore-db.sh against stub mysql and mysqldump. Linux only; see deploySandbox.ts. */
describe.skipIf(notLinux)('restore-db.sh', { timeout: SCRIPT_TEST_TIMEOUT_MS }, () => {
  let dump: string;

  useSandbox(() => {
    dump = path.join(sandbox.root, 'dump.sql.gz');
    fs.writeFileSync(dump, zlib.gzipSync('CREATE TABLE t (id INT);\n'));
  });

  /** Runs restore-db.sh in the work checkout, feeding `input` to its prompt. */
  function restore(args: string[], input = ''): SpawnSyncReturns<string> {
    return spawnSync('bash', ['scripts/restore-db.sh', ...args], { cwd: sandbox.work, env: sandbox.env, encoding: 'utf8', input });
  }

  it('restores into a scratch database without asking', () => {
    const result = restore([dump, 'bcuk_restore_test']);

    expect(result.status).toBe(0);
    const calls = read(path.join(sandbox.state, 'mysql-calls')).split('\n');
    expect(calls[0]).toContain('CREATE DATABASE IF NOT EXISTS `bcuk_restore_test`');
    // The import itself must target the scratch database, not the live one.
    expect(calls[1]).toMatch(/^--defaults-extra-file=\S+ bcuk_restore_test$/);
    expect(read(path.join(sandbox.state, 'mysql-input'))).toContain('CREATE TABLE t');
  });

  it('refuses to restore over the live database while the service is running', () => {
    write(path.join(sandbox.state, 'service-state'), 'active');
    const result = restore([dump], 'bcuk\n');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is running. Stop it first');
    expect(read(path.join(sandbox.state, 'mysql-input'))).toBe('');
  });

  it("refuses when it can't tell whether the service is running", () => {
    write(path.join(sandbox.state, 'service-state'), 'error');
    const result = restore([dump], 'bcuk\n');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Couldn't tell whether bcuk-bot is running");
    expect(read(path.join(sandbox.state, 'mysql-input'))).toBe('');
  });

  it('drops tables the dump does not contain before importing it', () => {
    write(path.join(sandbox.state, 'existing-tables'), 'sessions\nt\n');
    const result = restore([dump, 'bcuk_restore_test'], 'bcuk_restore_test\n');

    expect(result.status).toBe(0);
    const input = read(path.join(sandbox.state, 'mysql-input'));
    expect(input.indexOf('SET FOREIGN_KEY_CHECKS=0;')).toBe(0);
    expect(input).toContain('DROP TABLE IF EXISTS `sessions`;');
    // The drops run before the import, against the target database.
    expect(input.indexOf('DROP TABLE IF EXISTS `sessions`;')).toBeLessThan(input.indexOf('CREATE TABLE t'));
    const calls = read(path.join(sandbox.state, 'mysql-calls')).split('\n');
    expect(calls[1]).toMatch(/^--defaults-extra-file=\S+ bcuk_restore_test$/);
    expect(calls[2]).toMatch(/^--defaults-extra-file=\S+ bcuk_restore_test$/);
  });

  it('needs the name typed before wiping a non-live database that already has tables', () => {
    write(path.join(sandbox.state, 'existing-tables'), 'sessions\n');
    const result = restore([dump, 'other_app_db'], 'nope\n');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("'other_app_db' already has tables");
    expect(result.stderr).toContain('Not confirmed; nothing was changed.');
    expect(read(path.join(sandbox.state, 'mysql-input'))).toBe('');
  });

  it('drops views too, and doubles backticks in names, when clearing the target', () => {
    write(path.join(sandbox.state, 'existing-tables'), 'view:recent_users\n');
    expect(restore([dump, 'bcuk_restore_test'], 'bcuk_restore_test\n').status).toBe(0);

    // A database holding only a view still counts as non-empty, and the view is dropped as one.
    expect(read(path.join(sandbox.state, 'mysql-input'))).toContain('DROP VIEW IF EXISTS `recent_users`;');
    const query = read(path.join(sandbox.state, 'drops-query'));
    expect(query).toContain("IF(table_type = 'VIEW', 'DROP VIEW IF EXISTS `', 'DROP TABLE IF EXISTS `')");
    expect(query).toContain("REPLACE(table_name, '`', '``')");
    expect(query).not.toContain('BASE TABLE');
  });

  it('drops stored procedures and functions too, so ones added since the backup go', () => {
    write(path.join(sandbox.state, 'existing-tables'), 'procedure:added_later\nfunction:helper\n');
    expect(restore([dump, 'bcuk_restore_test'], 'bcuk_restore_test\n').status).toBe(0);

    const input = read(path.join(sandbox.state, 'mysql-input'));
    expect(input).toContain('DROP PROCEDURE IF EXISTS `added_later`;');
    expect(input).toContain('DROP FUNCTION IF EXISTS `helper`;');
    const query = read(path.join(sandbox.state, 'drops-query'));
    expect(query).toContain("CONCAT('DROP ', routine_type, ' IF EXISTS `', REPLACE(routine_name, '`', '``'), '`;') AS stmt FROM information_schema.routines");
    // Events are left alone: dumps don't hold them, so dropping them would lose them for good.
    expect(query).not.toContain('information_schema.events');
    // Routines go first (a missing ALTER ROUTINE privilege then fails before any table is dropped),
    // and --raw keeps -B from escaping a tab, newline or backslash in a name.
    expect(query).toMatch(/SELECT 0 AS step, CONCAT\('DROP ', routine_type[\s\S]*UNION ALL SELECT 1,[\s\S]*ORDER BY step/);
    expect(query.split(' ')).toContain('--raw');
  });

  it('saves the live database before replacing it, and skips that for a scratch database', () => {
    expect(restore([dump, 'bcuk_restore_test']).status).toBe(0);
    expect(fs.existsSync(path.join(sandbox.state, 'mysqldump-args'))).toBe(false);

    write(path.join(sandbox.state, 'existing-tables'), 'sessions\n');
    const result = restore([dump], 'bcuk\n');

    expect(result.status).toBe(0);
    const saved = fs.readdirSync(sandbox.backups).filter((f) => f.endsWith('-pre-restore.sql.gz'));
    expect(saved).toHaveLength(1);
    expect(result.stdout).toContain(`Saved the current data to ${path.join(sandbox.backups, saved[0]!)}`);
    expect(read(path.join(sandbox.state, 'mysqldump-args'))).toContain('bcuk');
    // The save ran before anything was dropped, and the import still followed.
    expect(result.stdout.indexOf('Saved the current data')).toBeLessThan(result.stdout.indexOf('Clearing the existing tables'));
    expect(read(path.join(sandbox.state, 'mysql-input'))).toContain('CREATE TABLE t');
  });

  it('changes nothing when the live database cannot be saved first', () => {
    write(path.join(sandbox.state, 'existing-tables'), 'sessions\n');
    const result = spawnSync('bash', ['scripts/restore-db.sh', dump], {
      cwd: sandbox.work, env: { ...sandbox.env, MYSQLDUMP_EXIT: '2' }, encoding: 'utf8', input: 'bcuk\n',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Couldn't back up 'bcuk' before restoring; nothing was changed.");
    expect(read(path.join(sandbox.state, 'mysql-input'))).toBe('');
    expect(read(path.join(sandbox.state, 'mysql-calls'))).toBe('');
  });

  it('restores the chosen dump even when saving the live database prunes it', () => {
    // BACKUP_KEEP=1: the pre-restore save leaves only itself, deleting the older dump being restored.
    write(path.join(sandbox.work, '.env'), `DB_USER=bot\nDB_NAME=bcuk\nBACKUP_DIR=${sandbox.backups}\nBACKUP_KEEP=1\n`);
    const chosen = path.join(sandbox.backups, 'bcuk-20200101T000000Z-1.sql.gz');
    fs.mkdirSync(sandbox.backups, { recursive: true });
    fs.copyFileSync(dump, chosen);
    write(path.join(sandbox.state, 'existing-tables'), 'sessions\n');

    const result = restore([chosen], 'bcuk\n');

    expect(result.status).toBe(0);
    expect(fs.existsSync(chosen)).toBe(false);
    expect(read(path.join(sandbox.state, 'mysql-input'))).toContain('CREATE TABLE t');
  });

  it('restores into an empty or missing live database without trying to save it first', () => {
    const result = restore([dump], 'bcuk\n');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("'bcuk' is empty or doesn't exist yet, so there's nothing to save first.");
    expect(fs.existsSync(path.join(sandbox.state, 'mysqldump-args'))).toBe(false);
    expect(read(path.join(sandbox.state, 'mysql-input'))).toContain('CREATE TABLE t');
  });

  it("changes nothing when it can't tell whether the live database holds anything", () => {
    const result = spawnSync('bash', ['scripts/restore-db.sh', dump], {
      cwd: sandbox.work, env: { ...sandbox.env, MYSQL_COUNT_EXIT: '1' }, encoding: 'utf8', input: 'bcuk\n',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Couldn't check what 'bcuk' holds; nothing was changed.");
    expect(fs.existsSync(path.join(sandbox.state, 'mysqldump-args'))).toBe(false);
    expect(read(path.join(sandbox.state, 'mysql-input'))).toBe('');
    expect(read(path.join(sandbox.state, 'mysql-calls'))).toBe('');
  });

  it('treats a case variant of the live database as the live one when the server ignores case', () => {
    write(path.join(sandbox.state, 'service-state'), 'active');
    const result = spawnSync('bash', ['scripts/restore-db.sh', dump, 'BCUK'], {
      cwd: sandbox.work, env: { ...sandbox.env, MYSQL_LOWER_CASE: '1' }, encoding: 'utf8', input: 'bcuk\n',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("'BCUK' is the live database 'bcuk' on this server");
    // So the live-database checks apply: here, the running service stops it.
    expect(result.stderr).toContain('is running. Stop it first');
    expect(read(path.join(sandbox.state, 'mysql-input'))).toBe('');
  });

  it('treats a case variant as a separate database when the server keeps case', () => {
    const result = restore([dump, 'BCUK']);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('is the live database');
    expect(fs.existsSync(path.join(sandbox.state, 'mysqldump-args'))).toBe(false);
    expect(read(path.join(sandbox.state, 'mysql-calls')).split('\n')[1]).toMatch(/^--defaults-extra-file=\S+ BCUK$/);
  });

  it("changes nothing when it can't tell whether the server ignores the case of names", () => {
    const result = spawnSync('bash', ['scripts/restore-db.sh', dump, 'bcuk_restore_test'], {
      cwd: sandbox.work, env: { ...sandbox.env, MYSQL_LOWER_CASE_EXIT: '1' }, encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Couldn't read lower_case_table_names from the server; nothing was changed.");
    expect(read(path.join(sandbox.state, 'mysql-calls'))).toBe('');
  });

  it('needs the database name typed before replacing the live database', () => {
    expect(restore([dump], 'nope\n').status).toBe(1);
    expect(read(path.join(sandbox.state, 'mysql-input'))).toBe('');

    expect(restore([dump], 'bcuk\n').status).toBe(0);
    expect(read(path.join(sandbox.state, 'mysql-input'))).toContain('CREATE TABLE t');
    expect(read(path.join(sandbox.state, 'mysql-calls')).split('\n')[1]).toMatch(/^--defaults-extra-file=\S+ bcuk$/);
  });
});
