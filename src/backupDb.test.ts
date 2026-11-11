import { describe, it, expect } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { SCRIPT_TEST_TIMEOUT_MS, notLinux, read, sandbox, useSandbox, write } from './test-utils/deploySandbox';

/** End-to-end tests for scripts/backup-db.sh against stub mysqldump. Linux only; see deploySandbox.ts. */
describe.skipIf(notLinux)('backup-db.sh', { timeout: SCRIPT_TEST_TIMEOUT_MS }, () => {
  useSandbox();

  /** Runs backup-db.sh in the work checkout. */
  function backup(args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
    return spawnSync('bash', ['scripts/backup-db.sh', ...args], { cwd: sandbox.work, env: { ...sandbox.env, ...extraEnv }, encoding: 'utf8' });
  }

  it('refuses when a DB_ setting is exported in the shell with a value other than .env\'s', () => {
    const result = backup([], { DB_NAME: 'other_db' });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/DB_NAME is exported in this shell with a different value from \S*\.env's\./);
    expect(fs.existsSync(path.join(sandbox.state, 'mysqldump-args'))).toBe(false);
  });

  it('accepts exported DB_ settings that match .env, including the default host and port', () => {
    expect(backup([], { DB_NAME: 'bcuk', DB_HOST: 'localhost', DB_PORT: '3306' }).status).toBe(0);
  });

  it('writes a private gzipped dump and prints its path', () => {
    const result = backup(['nightly']);

    expect(result.status).toBe(0);
    const file = result.stdout.trim().split('\n').pop()!; // the script's last line is the path
    expect(path.basename(file)).toMatch(/^bcuk-\d{8}T\d{6}Z-\d+-nightly\.sql\.gz$/);
    expect(zlib.gunzipSync(fs.readFileSync(file)).toString()).toContain('-- dump of');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(sandbox.backups).mode & 0o777).toBe(0o700);
  });

  it('keeps the password off the command line, in an escaped option file it deletes afterwards', () => {
    backup();

    const args = read(path.join(sandbox.state, 'mysqldump-args'));
    expect(args).not.toContain('p#ss');
    expect(args).toContain('--single-transaction');
    expect(read(path.join(sandbox.state, 'mysqldump-credentials'))).toContain('password="p#ss \\"word\\""');
    const optionFile = args.split('\n').find((a) => a.startsWith('--defaults-extra-file='))!.split('=')[1]!;
    expect(fs.existsSync(optionFile)).toBe(false);
  });

  it('keeps only the newest BACKUP_KEEP dumps of this database', () => {
    fs.mkdirSync(sandbox.backups, { recursive: true });
    for (const stamp of ['20200101T000000Z', '20200102T000000Z', '20200103T000000Z']) {
      write(path.join(sandbox.backups, `bcuk-${stamp}.sql.gz`), 'old');
    }
    write(path.join(sandbox.backups, 'bcuk_other-20200101T000000Z.sql.gz'), 'another database');
    backup();

    const left = fs.readdirSync(sandbox.backups).sort();
    expect(left).toHaveLength(4);
    expect(left).not.toContain('bcuk-20200101T000000Z.sql.gz');
    expect(left).toContain('bcuk_other-20200101T000000Z.sql.gz');
  });

  it('never prunes the dump it just made, even when it sorts among the oldest', () => {
    // A dump named for a later second sorts after this one, so with BACKUP_KEEP=1 a plain
    // "delete the oldest" would delete the dump just made.
    write(path.join(sandbox.work, '.env'), `DB_USER=bot\nDB_NAME=bcuk\nBACKUP_DIR=${sandbox.backups}\nBACKUP_KEEP=1\n`);
    write(path.join(sandbox.backups, 'bcuk-29990101T000000Z-1.sql.gz'), 'sorts last');
    const result = backup();

    expect(result.status).toBe(0);
    const made = result.stdout.trim().split('\n').pop()!;
    expect(fs.existsSync(made)).toBe(true);
    expect(fs.readdirSync(sandbox.backups)).toEqual([path.basename(made)]);
  });

  it('leaves no file behind and fails when mysqldump fails', () => {
    const result = backup([], { MYSQLDUMP_EXIT: '2' });

    expect(result.status).not.toBe(0);
    expect(fs.readdirSync(sandbox.backups)).toEqual([]);
  });

  it("reads .env lines the way dotenv does, including `export` and spaces around '='", () => {
    write(path.join(sandbox.work, '.env'), `export DB_USER=bot\nDB_NAME = bcuk_alt # comment\nBACKUP_DIR=${sandbox.backups}\n`);
    const result = backup();

    expect(result.status).toBe(0);
    expect(path.basename(result.stdout.trim())).toMatch(/^bcuk_alt-/);
    expect(read(path.join(sandbox.state, 'mysqldump-credentials'))).toContain('user="bot"');
  });

  it('keeps an escaped quote inside a quoted value, as dotenv does', () => {
    write(path.join(sandbox.work, '.env'), `DB_USER='it\\'s'\nDB_PASSWORD="p\\"ss" # comment\nDB_NAME=bcuk\nBACKUP_DIR=${sandbox.backups}\n`);
    expect(backup().status).toBe(0);

    // dotenv reads these as it\'s and p\"ss; the option file escapes each backslash and quote.
    const credentials = read(path.join(sandbox.state, 'mysqldump-credentials'));
    expect(credentials).toContain(String.raw`user="it\\'s"`);
    expect(credentials).toContain(String.raw`password="p\\\"ss"`);
  });

  it('rejects a label that could escape the file name', () => {
    const result = backup(['../x']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('The label may only contain');
  });
});
