import { beforeEach, afterEach } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Shared sandbox for the deploy.sh / backup-db.sh / restore-db.sh tests. Each test builds a
 * throwaway checkout (a clone of a bare "origin") and runs the real scripts against stub
 * `systemctl`, `sudo`, `npm`, `curl`, `ss`, `journalctl`, `mysqldump` and `mysql` on PATH. The stubs
 * keep their state in files under `state/`: which build is "running", how many restarts there were,
 * what was dumped. Linux only, like the server the scripts run on.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NODE_BIN = process.execPath;
// The scripts target the Linux server (GNU find's -printf, /proc), so these only run on Linux.
export const notLinux = process.platform !== 'linux';
/** These spawn real git and bash processes, which run slowly on a busy CI runner under coverage. */
export const SCRIPT_TEST_TIMEOUT_MS = 30_000;

/** Stub commands, keyed by name. `$STATE` is the state directory. */
const STUBS: Record<string, string> = {
  // The real mv, then (with MV_INTERRUPT naming the folder being moved) a TERM to deploy.sh: an
  // interrupt landing right after the move, before the script can note that it happened.
  mv: `#!/usr/bin/env bash
/bin/mv "$@" || exit
if [ -n "\${MV_INTERRUPT:-}" ] && [ "$1" = "$MV_INTERRUPT" ]; then kill -TERM "$PPID"; sleep 1; fi
`,
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
  is-active)
    state="$(cat "$STATE/service-state" 2>/dev/null || echo inactive)"
    [ "$state" = error ] && exit 1
    echo "$state"; [ "$state" = active ] ;;
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
calls=$(( $(cat "$STATE/curl-calls" 2>/dev/null || echo 0) + 1 )); echo "$calls" > "$STATE/curl-calls"
printf '%s\\n' "\${@: -1}" >> "$STATE/curl-urls"
printf '%s\\n' "$*" >> "$STATE/curl-args"
[ "$calls" = "\${CURL_FAIL_CALL:-}" ] && exit 7
running="$(cat "$STATE/running" 2>/dev/null)"
for bad in $UNHEALTHY_BUILDS; do [ "$running" = "$bad" ] && exit 7; done
exit 0
`,
  ss: `#!/usr/bin/env bash
echo 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid='"\${SS_PID:-4242}"',fd=20))'
`,
  journalctl: `#!/usr/bin/env bash
running="$(cat "$STATE/running" 2>/dev/null)"
if [ -f "$STATE/journal-$running" ]; then cat "$STATE/journal-$running"; else echo "-- No entries --"; fi
`,
  npm: `#!/usr/bin/env bash
version="$(cat VERSION)"
case "$1" in
  ci) mkdir -p node_modules && echo "$version" > node_modules/marker && echo "{}" > node_modules/.package-lock.json ;;
  install|audit|prune) exit 0 ;;
  test)
    if [ -n "\${NPM_TEST_SIGNAL:-}" ]; then
      # With a hanging build, wait (up to 10s) until its child is running, so the interrupt lands
      # while there is something for the rollback to stop.
      if [ -n "\${NPM_BUILD_HANG:-}" ]; then
        for _ in $(seq 100); do [ -s "$STATE/build-child" ] && break; sleep 0.1; done
      fi
      kill -TERM "$PPID"; sleep 1
    fi
    exit "\${NPM_TEST_EXIT:-0}" ;;
  run)
    out="$5"
    # NPM_BUILD_HANG: a build still running when the deploy is interrupted, with a child process
    # of its own (like tsc under npm), whose PID is kept for the test to check. "ignore-term" makes
    # that child ignore TERM, like a stuck process the rollback has to kill.
    case "\${NPM_BUILD_HANG:-}" in
      ignore-term) (trap '' TERM; exec sleep 30) & echo "$!" > "$STATE/build-child"; wait ;;
      ?*) sleep 30 & echo "$!" > "$STATE/build-child"; wait ;;
    esac
    mkdir -p "$out" && echo "$version" > "$out/marker" && : > "$out/index.js" ;;
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
case "$*" in
  *"FROM schema_migrations"*)
    # MYSQL_QUERY_EXIT fails the query; MYSQL_QUERY_FAIL_FROM=N only from the Nth query on (deploy.sh
    # reads it once before the restart and again after a failed one).
    queries=$(( $(cat "$STATE/schema-queries" 2>/dev/null || echo 0) + 1 )); echo "$queries" > "$STATE/schema-queries"
    if [ "\${MYSQL_QUERY_EXIT:-0}" != 0 ] || [ "$queries" -ge "\${MYSQL_QUERY_FAIL_FROM:-999}" ]; then
      echo "ERROR 2003: Can't connect" >&2; exit "\${MYSQL_QUERY_EXIT:-1}"
    fi
    cat "$STATE/applied-migrations" 2>/dev/null
    [ -f "$STATE/migration-lock" ] && echo __migration_lock_held__
    exit 0 ;;
  *"COUNT(*)"*)
    # The restore's "anything to save?" count: one object per line of existing-tables, or a
    # failure with MYSQL_COUNT_EXIT.
    [ -n "\${MYSQL_COUNT_EXIT:-}" ] && { echo "ERROR 1045: Access denied" >&2; exit "$MYSQL_COUNT_EXIT"; }
    cat "$STATE/existing-tables" 2>/dev/null | grep -c . || true
    exit 0 ;;
  *"@@lower_case_table_names"*)
    # The restore's "does this server ignore the case of names?" check. MYSQL_LOWER_CASE sets the
    # answer (default 0); MYSQL_LOWER_CASE_EXIT fails it.
    [ -n "\${MYSQL_LOWER_CASE_EXIT:-}" ] && { echo "ERROR 2003: Can't connect" >&2; exit "$MYSQL_LOWER_CASE_EXIT"; }
    echo "\${MYSQL_LOWER_CASE:-0}"
    exit 0 ;;
  *"information_schema"*)
    # The restore's "what exists?" query: one DROP statement per line of existing-tables, where a
    # "view:", "procedure:" or "function:" prefix marks one of those. The query itself is kept for the tests to check.
    printf '%s\\n' "$*" > "$STATE/drops-query"
    while read -r table; do
      case "$table" in
        view:*) echo "DROP VIEW IF EXISTS \\\`\${table#view:}\\\`;" ;;
        procedure:*) echo "DROP PROCEDURE IF EXISTS \\\`\${table#procedure:}\\\`;" ;;
        function:*) echo "DROP FUNCTION IF EXISTS \\\`\${table#function:}\\\`;" ;;
        ?*) echo "DROP TABLE IF EXISTS \\\`$table\\\`;" ;;
      esac
    done < "$STATE/existing-tables" 2>/dev/null
    exit 0 ;;
esac
printf '%s\\n' "$*" >> "$STATE/mysql-calls"
cat >> "$STATE/mysql-input"
`,
};

/** A throwaway checkout plus everything the scripts need around it. */
export interface Sandbox {
  root: string;
  origin: string;
  work: string;
  dev: string;
  state: string;
  backups: string;
  env: NodeJS.ProcessEnv;
}

/** The sandbox of the test now running (set by `createSandbox`). */
export let sandbox: Sandbox;

/**
 * Runs a command, failing the test with its output if it doesn't exit 0.
 * @param cmd - Executable to run.
 * @param args - Arguments for the executable.
 * @param cwd - Directory to run it in.
 * @param env - Environment for the process; defaults to the sandbox's.
 * @returns The command's stdout.
 */
export function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = sandbox.env): string {
  const result = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/**
 * Writes a file, creating its directory.
 * @param file - Absolute path of the file.
 * @param content - Text to write.
 * @param mode - Optional file mode (e.g. 0o755 for a script).
 */
export function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
}

/**
 * Whether a process is still running: it exists and isn't a zombie waiting to be reaped.
 * @param pid - Process ID to check.
 * @returns True while the process is alive.
 */
export function isRunning(pid: number): boolean {
  const stat = path.join('/proc', String(pid), 'stat');
  if (!fs.existsSync(stat)) return false;
  // The state letter follows the parenthesised command name.
  return fs.readFileSync(stat, 'utf8').split(') ')[1]?.[0] !== 'Z';
}

/**
 * Reads a file's trimmed contents, or '' when it doesn't exist.
 * @param file - Absolute path of the file.
 * @returns The trimmed text, or an empty string.
 */
export function read(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
}

/**
 * Copies one of the repo's real scripts into the dev checkout.
 * @param relative - Script path relative to the repo root.
 */
export function copyScript(relative: string): void {
  write(path.join(sandbox.dev, relative), fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8'), 0o755);
}

/**
 * Commits everything in the dev checkout as `version` and pushes it to origin.
 * @param version - Label written to VERSION and used as the commit message.
 * @param changes - Optional callback that edits the dev checkout before the commit.
 */
export function commitVersion(version: string, changes: (dev: string) => void = () => {}): void {
  write(path.join(sandbox.dev, 'VERSION'), `${version}\n`);
  changes(sandbox.dev);
  run('git', ['add', '-A'], sandbox.dev);
  run('git', ['commit', '-qm', version], sandbox.dev);
  run('git', ['push', '-q', 'origin', 'HEAD:main'], sandbox.dev);
}

/**
 * Builds the sandbox: origin with v1 deployed in `work` (its dist/ and node_modules/ marked v1),
 * and a `dev` clone to push later versions from.
 * @returns The new sandbox, also stored in `sandbox`.
 */
export function createSandbox(): Sandbox {
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
    // Short, so a build that never comes up fails in a fraction of a second. deploy.sh's own
    // defaults (1s poll, 90s health, 30s stability) are pinned in deploy.health.test.ts.
    DEPLOY_POLL_INTERVAL_SECONDS: '0.05',
    DEPLOY_HEALTH_TIMEOUT_SECONDS: '0.3',
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
  write(path.join(sandbox.work, 'dist/index.js'), '');
  write(path.join(sandbox.work, 'node_modules/marker'), 'v1\n');
  write(path.join(sandbox.work, 'node_modules/.package-lock.json'), '{}\n');
  write(path.join(state, 'running'), 'v1\n');
  // The database already records the migration the checkout starts with, as a real one would.
  write(path.join(state, 'applied-migrations'), '0001_baseline\n');
  return sandbox;
}

/**
 * Runs deploy.sh in the work checkout with extra environment variables.
 * @param extraEnv - Variables added to the sandbox environment for this run.
 * @returns The finished process, with its output as text.
 */
export function deploy(extraEnv: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync('bash', ['deploy.sh'], { cwd: sandbox.work, env: { ...sandbox.env, ...extraEnv }, encoding: 'utf8' });
}

/**
 * The builds the stub service was restarted onto, in order.
 * @returns One build marker per restart.
 */
export function restarts(): string[] {
  return read(path.join(sandbox.state, 'restarts')).split('\n').filter(Boolean);
}

/**
 * Short SHA of the work checkout's HEAD.
 * @returns The abbreviated commit hash.
 */
export function workHead(): string {
  return run('git', ['rev-parse', '--short', 'HEAD'], sandbox.work).trim();
}

/**
 * The failure report deploy.sh saved.
 * @returns The report's trimmed text, or '' when none was written.
 */
export function failureReport(): string {
  return read(path.join(sandbox.work, 'logs/last-deploy-failure.log'));
}

/**
 * Pushes v2 with a dependency change (so node_modules is replaced) and, optionally, a migration.
 * @param options - `migration`: also add migrations/0002_add_thing.sql.
 * @param options.migration - Whether v2 adds a migration file.
 */
export function pushV2({ migration = false } = {}): void {
  commitVersion('v2', (dev) => {
    write(path.join(dev, 'package-lock.json'), '{"lockfileVersion":3,"rev":2}\n');
    if (migration) write(path.join(dev, 'migrations/0002_add_thing.sql'), 'SELECT 2;\n');
  });
}

/**
 * Registers a `beforeEach` that builds a fresh sandbox and an `afterEach` that removes it, for the
 * `describe` block this is called in.
 * @param setup - Optional extra setup to run after each sandbox is built.
 */
export function useSandbox(setup?: () => void): void {
  beforeEach(() => {
    createSandbox();
    setup?.();
  });
  afterEach(() => {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });
}
