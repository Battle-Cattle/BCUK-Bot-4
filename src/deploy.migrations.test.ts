import { describe, it, expect } from 'vitest';
import path from 'path';
import { SCRIPT_TEST_TIMEOUT_MS, commitVersion, deploy, failureReport, notLinux, pushV2, read, restarts, run, sandbox, useSandbox, workHead, write } from './test-utils/deploySandbox';

/** End-to-end tests for deploy.sh: migrations. Linux only; see deploySandbox.ts. */
describe.skipIf(notLinux)('deploy.sh (migrations)', { timeout: SCRIPT_TEST_TIMEOUT_MS }, () => {
  useSandbox();

  it('stops and explains instead of rolling back when the failed build already applied a new migration', () => {
    pushV2({ migration: true });
    // Recorded in the database, which is what counts, even though the bot logged nothing about it.
    write(path.join(sandbox.state, 'applied-migrations'), '0001_baseline\n0002_add_thing\n');
    const result = deploy({ UNHEALTHY_BUILDS: 'v2' });

    expect(result.status).toBe(1);
    expect(read(path.join(sandbox.work, 'dist/marker'))).toBe('v2');
    expect(restarts()).toEqual(['v2']);
    const report = failureReport();
    expect(report).toContain('NOT rolling back automatically');
    expect(report).toContain('The database records these as applied: 0002_add_thing.');
    expect(report).toMatch(/bash scripts\/restore-db\.sh ".*-pre-deploy\.sql\.gz"/);
    expect(report).toContain('mv dist.old dist');
    expect(report).toContain('mv node_modules.old node_modules');
  });

  it('stops instead of rolling back when the deploy adds a migration the database never recorded', () => {
    pushV2({ migration: true });
    // A migration that failed part way leaves its earlier DDL applied but unrecorded.
    write(path.join(sandbox.state, 'applied-migrations'), '0001_baseline\n');
    const result = deploy({ UNHEALTHY_BUILDS: 'v2' });

    expect(result.status).toBe(1);
    expect(read(path.join(sandbox.work, 'dist/marker'))).toBe('v2');
    expect(restarts()).toEqual(['v2']);
    const report = failureReport();
    expect(report).toContain('NOT rolling back automatically');
    expect(report).toContain('0002_add_thing');
    expect(report).toContain('None is recorded as applied, but one that failed part way');
  });

  it('stops instead of rolling back while a migration is still running', () => {
    pushV2({ migration: true });
    // Nothing recorded yet, but the runner still holds its lock: restarting would cut it off.
    write(path.join(sandbox.state, 'applied-migrations'), '0001_baseline\n');
    write(path.join(sandbox.state, 'migration-lock'), '');
    const result = deploy({ UNHEALTHY_BUILDS: 'v2' });

    expect(result.status).toBe(1);
    expect(restarts()).toEqual(['v2']);
    expect(failureReport()).toContain('NOT rolling back automatically');
    expect(failureReport()).toContain('A migration is still running');
  });

  it("assumes a new migration was applied when it can't query schema_migrations after the restart, and stops", () => {
    pushV2({ migration: true });
    const result = deploy({ UNHEALTHY_BUILDS: 'v2', MYSQL_QUERY_FAIL_FROM: '2' });

    expect(result.status).toBe(1);
    expect(restarts()).toEqual(['v2']);
    expect(failureReport()).toContain('NOT rolling back automatically');
    expect(failureReport()).toContain("Couldn't read schema_migrations to check how far they got");
  });

  it('counts a renamed migration file as new', () => {
    commitVersion('v1b', (dev) => write(path.join(dev, 'migrations/0002_old_name.sql'), 'SELECT 2;\n'));
    run('git', ['pull', '-q', 'origin', 'main'], sandbox.work);
    commitVersion('v2', (dev) => run('git', ['mv', 'migrations/0002_old_name.sql', 'migrations/0002_new_name.sql'], dev));
    write(path.join(sandbox.state, 'applied-migrations'), '0002_new_name\n');
    const result = deploy({ UNHEALTHY_BUILDS: 'v2' });

    expect(result.status).toBe(1);
    expect(failureReport()).toContain('0002_new_name');
    expect(failureReport()).toContain('NOT rolling back automatically');
  });

  it("won't restart onto new migrations without a backup", () => {
    const before = workHead();
    pushV2({ migration: true });
    const result = deploy({ MYSQLDUMP_EXIT: '2' });

    expect(result.status).toBe(1);
    expect(workHead()).toBe(before);
    expect(restarts()).toEqual([]);
    expect(read(path.join(sandbox.work, 'dist/marker'))).toBe('v1');
    expect(failureReport()).toContain("couldn't back up the database, and this deploy applies migrations (0002_add_thing)");
  });

  it('treats a migration the database never recorded as new, even when an earlier deploy already pulled it', () => {
    // An interrupted deploy pulled 0002 (so this deploy's diff is empty) but it was never applied.
    pushV2({ migration: true });
    run('git', ['pull', '-q', 'origin', 'main'], sandbox.work);
    const before = workHead();
    const result = deploy({ MYSQLDUMP_EXIT: '2' });

    expect(result.status).toBe(1);
    expect(workHead()).toBe(before);
    expect(restarts()).toEqual([]);
    expect(failureReport()).toContain("couldn't back up the database, and this deploy applies migrations (0002_add_thing)");
  });

  it("requires the backup, and never rolls back automatically, when it can't read the migration state before the restart", () => {
    pushV2();
    const noBackup = deploy({ MYSQL_QUERY_EXIT: '1', MYSQLDUMP_EXIT: '2' });
    expect(noBackup.status).toBe(1);
    expect(restarts()).toEqual([]);
    expect(failureReport()).toContain('this deploy applies migrations (unknown which)');

    const unhealthy = deploy({ MYSQL_QUERY_EXIT: '1', UNHEALTHY_BUILDS: 'v2' });
    expect(unhealthy.status).toBe(1);
    expect(restarts()).toEqual(['v2']);
    expect(failureReport()).toContain('NOT rolling back automatically');
    expect(failureReport()).toContain("Couldn't read schema_migrations before the restart");
  });

  it('only warns about a failed backup when the deploy adds no migrations', () => {
    pushV2();
    const result = deploy({ MYSQLDUMP_EXIT: '2' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("WARNING: Couldn't back up the database");
    expect(restarts()).toEqual(['v2']);
  });
});
