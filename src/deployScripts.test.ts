import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

/**
 * End-to-end tests for deploy.sh and the backup scripts. Each test builds a throwaway checkout (a
 * clone of a bare "origin") and runs the real scripts against stub `systemctl`, `sudo`, `npm`,
 * `curl`, `ss`, `journalctl`, `mysqldump` and `mysql` on PATH. The stubs keep their state in
 * files under `state/`: which build is "running", how many restarts there were, what was dumped.
 * POSIX shells only, so these don't run on Windows.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const NODE_BIN = process.execPath;
const onWindows = process.platform === 'win32';
/** These spawn real git and bash processes, which run slowly on a busy CI runner under coverage. */
const SCRIPT_TEST_TIMEOUT_MS = 30_000;

/** Stub commands, keyed by name. `$STATE` is the state directory. */
const STUBS: Record<string, string> = {
  systemctl: `#!/usr/bin/env bash
case "$1" in
  cat) exit 0 ;;
  show)
    case "$3" in
      ExecStart) echo "{ path=__NODE_BIN__ ; argv[]=__NODE_BIN__ dist/index.js }" ;;
      MainPID) echo 4242 ;;
      NRestarts) echo 0 ;;
    esac ;;
  is-failed) exit 1 ;;
  is-active) [ -f "$STATE/active" ] ;;
  status) echo "bcuk-bot.service - stub (running $(cat "$STATE/running" 2>/dev/null))" ;;
  restart)
    cat dist/marker > "$STATE/running"
    echo "$(cat dist/marker)" >> "$STATE/restarts" ;;
esac
`,
  sudo: `#!/usr/bin/env bash
for arg in "$@"; do [ "$arg" = "-l" ] && exit 0; done
[ "$1" = "-n" ] && shift
exec "$@"
`,
  curl: `#!/usr/bin/env bash
running="$(cat "$STATE/running" 2>/dev/null)"
for bad in $UNHEALTHY_BUILDS; do [ "$running" = "$bad" ] && exit 7; done
exit 0
`,
  ss: `#!/usr/bin/env bash
echo 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=4242,fd=20))'
`,
  journalctl: `#!/usr/bin/env bash
running="$(cat "$STATE/running" 2>/dev/null)"
if [ -f "$STATE/journal-$running" ]; then cat "$STATE/journal-$running"; else echo "-- No entries --"; fi
`,
  npm: `#!/usr/bin/env bash
version="$(cat VERSION)"
case "$1" in
  ci) mkdir -p node_modules && echo "$version" > node_modules/marker ;;
  install|audit|prune) exit 0 ;;
  test) exit "\${NPM_TEST_EXIT:-0}" ;;
  run)
    out="$5"
    mkdir -p "$out" && echo "$version" > "$out/marker" ;;
esac
`,
  mysqldump: `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$STATE/mysqldump-args"
for arg in "$@"; do
  case "$arg" in --defaults-extra-file=*) cp "\${arg#*=}" "$STATE/mysqldump-credentials" ;; esac
done
[ "\${MYSQLDUMP_EXIT:-0}" = 0 ] || { echo "mysqldump: stub failure" >&2; exit "$MYSQLDUMP_EXIT"; }
echo "-- dump of $STATE"
`,
  mysql: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STATE/mysql-calls"
cat >> "$STATE/mysql-input"
`,
};

/** A throwaway checkout plus everything the scripts need around it. */
interface Sandbox {
  root: string;
  origin: string;
  work: string;
  dev: string;
  state: string;
  backups: string;
  env: NodeJS.ProcessEnv;
}

let sandbox: Sandbox;

/** Runs a command, failing the test with its output if it doesn't exit 0. */
function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = sandbox.env): string {
  const result = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** Writes a file, creating its directory. */
function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
}

/** Reads a file's trimmed contents, or '' when it doesn't exist. */
function read(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
}

/** Copies one of the repo's real scripts into the dev checkout. */
function copyScript(relative: string): void {
  write(path.join(sandbox.dev, relative), fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8'), 0o755);
}

/** Commits everything in the dev checkout as `version` and pushes it to origin. */
function commitVersion(version: string, changes: (dev: string) => void = () => {}): void {
  write(path.join(sandbox.dev, 'VERSION'), `${version}\n`);
  changes(sandbox.dev);
  run('git', ['add', '-A'], sandbox.dev);
  run('git', ['commit', '-qm', version], sandbox.dev);
  run('git', ['push', '-q', 'origin', 'HEAD:main'], sandbox.dev);
}

/**
 * Builds the sandbox: origin with v1 deployed in `work` (its dist/ and node_modules/ marked v1),
 * and a `dev` clone to push later versions from.
 */
function createSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bcuk-deploy-'));
  const stubs = path.join(root, 'stubs');
  const state = path.join(root, 'state');
  const gitConfig = path.join(root, 'gitconfig');
  fs.mkdirSync(state);
  write(gitConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  for (const [name, body] of Object.entries(STUBS)) write(path.join(stubs, name), body.replaceAll("__NODE_BIN__", NODE_BIN), 0o755);
  const env: NodeJS.ProcessEnv = {
    PATH: `${stubs}:${process.env.PATH ?? ''}`,
    HOME: root,
    STATE: state,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    DEPLOY_HEALTH_TIMEOUT_SECONDS: '1',
    DEPLOY_STABILITY_SECONDS: '0',
    TZ: 'UTC',
  };
  sandbox = { root, origin: path.join(root, 'origin.git'), work: path.join(root, 'work'), dev: path.join(root, 'dev'), state, backups: path.join(root, 'backups'), env };
  run('git', ['init', '-q', '--bare', sandbox.origin], root);
  run('git', ['clone', '-q', sandbox.origin, sandbox.dev], root);
  for (const script of ['deploy.sh', 'scripts/backup-db.sh', 'scripts/restore-db.sh', 'scripts/lib/dotenv.sh']) copyScript(script);
  commitVersion('v1', (dev) => {
    write(path.join(dev, 'package.json'), JSON.stringify({ name: 'stub', engines: { node: '>=1.0.0' } }));
    write(path.join(dev, 'package-lock.json'), '{"lockfileVersion":3,"rev":1}\n');
    write(path.join(dev, 'migrations/0001_baseline.sql'), 'SELECT 1;\n');
    write(path.join(dev, '.gitignore'), 'node_modules/\nnode_modules.old/\ndist/\ndist.new/\ndist.old/\nlogs/\n.env\n');
  });
  run('git', ['clone', '-q', sandbox.origin, sandbox.work], root);
  write(path.join(sandbox.work, '.env'), `DB_USER=bot\nDB_PASSWORD='p#ss "word"'\nDB_NAME=bcuk\nBACKUP_DIR=${sandbox.backups}\nBACKUP_KEEP=3\n`);
  write(path.join(sandbox.work, 'dist/marker'), 'v1\n');
  write(path.join(sandbox.work, 'node_modules/marker'), 'v1\n');
  write(path.join(state, 'running'), 'v1\n');
  return sandbox;
}

/** Runs deploy.sh in the work checkout with extra environment variables. */
function deploy(extraEnv: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync('bash', ['deploy.sh'], { cwd: sandbox.work, env: { ...sandbox.env, ...extraEnv }, encoding: 'utf8' });
}

/** The builds the stub service was restarted onto, in order. */
function restarts(): string[] {
  return read(path.join(sandbox.state, 'restarts')).split('\n').filter(Boolean);
}

/** Short SHA of the work checkout's HEAD. */
function workHead(): string {
  return run('git', ['rev-parse', '--short', 'HEAD'], sandbox.work).trim();
}

/** The failure report deploy.sh saved. */
function failureReport(): string {
  return read(path.join(sandbox.work, 'logs/last-deploy-failure.log'));
}

/** Pushes v2 with a dependency change (so node_modules is replaced) and, optionally, a migration. */
function pushV2({ migration = false } = {}): void {
  commitVersion('v2', (dev) => {
    write(path.join(dev, 'package-lock.json'), '{"lockfileVersion":3,"rev":2}\n');
    if (migration) write(path.join(dev, 'migrations/0002_add_thing.sql'), 'SELECT 2;\n');
  });
}

describe.skipIf(onWindows)('deploy.sh', { timeout: SCRIPT_TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    createSandbox();
  });

  afterEach(() => {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });

  it('deploys a healthy build, backs up first and cleans up the previous build', () => {
    pushV2();
    const result = deploy();

    expect(result.stdout).toContain('Deploy complete');
    expect(result.status).toBe(0);
    expect(read(path.join(sandbox.work, 'dist/marker'))).toBe('v2');
    expect(read(path.join(sandbox.work, 'node_modules/marker'))).toBe('v2');
    expect(fs.existsSync(path.join(sandbox.work, 'dist.old'))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.work, 'node_modules.old'))).toBe(false);
    expect(restarts()).toEqual(['v2']);
    expect(fs.readdirSync(sandbox.backups).filter((f) => f.endsWith('-pre-deploy.sql.gz'))).toHaveLength(1);
  });

  it('rolls back code, build and dependencies, restarts the previous build and reports why when the new one is unhealthy', () => {
    const before = workHead();
    pushV2();
    const result = deploy({ UNHEALTHY_BUILDS: 'v2' });

    expect(result.status).toBe(1);
    expect(workHead()).toBe(before);
    expect(read(path.join(sandbox.work, 'dist/marker'))).toBe('v1');
    expect(read(path.join(sandbox.work, 'node_modules/marker'))).toBe('v1');
    expect(restarts()).toEqual(['v2', 'v1']);
    const report = failureReport();
    expect(report).toContain("bcuk-bot didn't come up healthy after the restart");
    expect(report).toContain(`Previous commit: ${before}`);
    expect(report).toContain('--- systemctl status bcuk-bot ---');
    expect(report).toContain('Rolled back: bcuk-bot is running the previous build');
    expect(result.stdout).toContain('Report saved to logs/last-deploy-failure.log');
  });

  it('says loudly when the previous build fails to come up too', () => {
    pushV2();
    const result = deploy({ UNHEALTHY_BUILDS: 'v1 v2' });

    expect(result.status).toBe(1);
    expect(restarts()).toEqual(['v2', 'v1']);
    expect(failureReport()).toContain('ROLLBACK FAILED');
    expect(failureReport()).toContain('The bot is DOWN');
  });

  it('rolls back without restarting when the tests fail', () => {
    const before = workHead();
    pushV2();
    const result = deploy({ NPM_TEST_EXIT: '1' });

    expect(result.status).toBe(1);
    expect(workHead()).toBe(before);
    expect(read(path.join(sandbox.work, 'dist/marker'))).toBe('v1');
    expect(read(path.join(sandbox.work, 'node_modules/marker'))).toBe('v1');
    expect(restarts()).toEqual([]);
    expect(failureReport()).toContain('the build or the tests failed');
    expect(failureReport()).toContain('the bot is still running the previous build');
  });

  it('stops and explains instead of rolling back when the failed build already applied a new migration', () => {
    pushV2({ migration: true });
    write(path.join(sandbox.state, 'journal-v2'), '2026-11-03 12:00:00 [info] [Migrations] Applying migration 0002_add_thing...\n');
    const result = deploy({ UNHEALTHY_BUILDS: 'v2' });

    expect(result.status).toBe(1);
    expect(read(path.join(sandbox.work, 'dist/marker'))).toBe('v2');
    expect(restarts()).toEqual(['v2']);
    const report = failureReport();
    expect(report).toContain('NOT rolling back automatically');
    expect(report).toContain('0002_add_thing');
    expect(report).toMatch(/bash scripts\/restore-db\.sh ".*-pre-deploy\.sql\.gz"/);
    expect(report).toContain('mv dist.old dist');
    expect(report).toContain('mv node_modules.old node_modules');
  });

  it('still rolls back when the deploy adds a migration that the failed build never applied', () => {
    const before = workHead();
    pushV2({ migration: true });
    write(path.join(sandbox.state, 'journal-v2'), '2026-11-03 12:00:00 [error] [Discord] Login failed\n');
    const result = deploy({ UNHEALTHY_BUILDS: 'v2' });

    expect(result.status).toBe(1);
    expect(workHead()).toBe(before);
    expect(restarts()).toEqual(['v2', 'v1']);
    expect(failureReport()).toContain('Rolled back');
  });

  it("assumes a new migration was applied when it can't read the bot's log, and stops", () => {
    pushV2({ migration: true });
    const result = deploy({ UNHEALTHY_BUILDS: 'v2' });

    expect(result.status).toBe(1);
    expect(restarts()).toEqual(['v2']);
    expect(failureReport()).toContain('NOT rolling back automatically');
  });

  it("reads the bot's own log for applied migrations when the journal is unreadable", () => {
    const before = workHead();
    pushV2({ migration: true });
    // Timestamps before the restart are ignored, so this old line doesn't count as applied now.
    write(path.join(sandbox.work, 'logs/combined-2026-11-03.log'), '2000-01-01 00:00:00 [info] [Migrations] Applying migration 0002_add_thing...\n');
    const result = deploy({ UNHEALTHY_BUILDS: 'v2' });

    expect(result.status).toBe(1);
    expect(workHead()).toBe(before);
    expect(restarts()).toEqual(['v2', 'v1']);
  });

  it("won't restart onto new migrations without a backup", () => {
    const before = workHead();
    pushV2({ migration: true });
    const result = deploy({ MYSQLDUMP_EXIT: '2' });

    expect(result.status).toBe(1);
    expect(workHead()).toBe(before);
    expect(restarts()).toEqual([]);
    expect(read(path.join(sandbox.work, 'dist/marker'))).toBe('v1');
    expect(failureReport()).toContain("couldn't back up the database, and this deploy adds migrations (0002_add_thing)");
  });

  it('only warns about a failed backup when the deploy adds no migrations', () => {
    pushV2();
    const result = deploy({ MYSQLDUMP_EXIT: '2' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("WARNING: Couldn't back up the database");
    expect(restarts()).toEqual(['v2']);
  });
});

describe.skipIf(onWindows)('backup-db.sh', { timeout: SCRIPT_TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    createSandbox();
  });

  afterEach(() => {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });

  /** Runs backup-db.sh in the work checkout. */
  function backup(args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
    return spawnSync('bash', ['scripts/backup-db.sh', ...args], { cwd: sandbox.work, env: { ...sandbox.env, ...extraEnv }, encoding: 'utf8' });
  }

  it('writes a private gzipped dump and prints its path', () => {
    const result = backup(['nightly']);

    expect(result.status).toBe(0);
    const file = result.stdout.trim().split('\n').pop()!; // the script's last line is the path
    expect(path.basename(file)).toMatch(/^bcuk-\d{8}T\d{6}Z-nightly\.sql\.gz$/);
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

  it('leaves no file behind and fails when mysqldump fails', () => {
    const result = backup([], { MYSQLDUMP_EXIT: '2' });

    expect(result.status).not.toBe(0);
    expect(fs.readdirSync(sandbox.backups)).toEqual([]);
  });

  it('rejects a label that could escape the file name', () => {
    const result = backup(['../x']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('The label may only contain');
  });
});

describe.skipIf(onWindows)('restore-db.sh', { timeout: SCRIPT_TEST_TIMEOUT_MS }, () => {
  let dump: string;

  beforeEach(() => {
    createSandbox();
    dump = path.join(sandbox.root, 'dump.sql.gz');
    fs.writeFileSync(dump, zlib.gzipSync('CREATE TABLE t (id INT);\n'));
  });

  afterEach(() => {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });

  /** Runs restore-db.sh in the work checkout, feeding `input` to its prompt. */
  function restore(args: string[], input = ''): SpawnSyncReturns<string> {
    return spawnSync('bash', ['scripts/restore-db.sh', ...args], { cwd: sandbox.work, env: sandbox.env, encoding: 'utf8', input });
  }

  it('restores into a scratch database without asking', () => {
    const result = restore([dump, 'bcuk_restore_test']);

    expect(result.status).toBe(0);
    expect(read(path.join(sandbox.state, 'mysql-calls'))).toContain('CREATE DATABASE IF NOT EXISTS `bcuk_restore_test`');
    expect(read(path.join(sandbox.state, 'mysql-input'))).toContain('CREATE TABLE t');
  });

  it('refuses to restore over the live database while the service is running', () => {
    write(path.join(sandbox.state, 'active'), '');
    const result = restore([dump], 'bcuk\n');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is running. Stop it first');
    expect(read(path.join(sandbox.state, 'mysql-input'))).toBe('');
  });

  it('needs the database name typed before replacing the live database', () => {
    expect(restore([dump], 'nope\n').status).toBe(1);
    expect(read(path.join(sandbox.state, 'mysql-input'))).toBe('');

    expect(restore([dump], 'bcuk\n').status).toBe(0);
    expect(read(path.join(sandbox.state, 'mysql-input'))).toContain('CREATE TABLE t');
  });
});
