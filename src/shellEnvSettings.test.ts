import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// deploy.sh, the systemd installer and the backup scripts all read .env with env_setting from
// scripts/lib/dotenv.sh, which parses it with the bot's own dotenv (scripts/envSetting.js). These
// tests run it, and deploy.sh's health-URL block, against sample files.

const REPO_ROOT = path.resolve(__dirname, '..');
const onWindows = process.platform === 'win32';

/** The text of a script from the line starting with `start` up to and including the line `end` matches. */
function scriptBlock(script: string, start: string, end: RegExp): string {
  const lines = fs.readFileSync(path.join(REPO_ROOT, script), 'utf8').split('\n');
  const from = lines.findIndex((line) => line.startsWith(start));
  const to = lines.findIndex((line, i) => i > from && end.test(line));
  if (from < 0 || to < 0) throw new Error(`${start} not found in ${script}`);
  return lines.slice(from, to + 1).join('\n');
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-setting-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs `body` in bash after the given script blocks, in a directory holding `env` as its .env.
 * The real scripts/lib/dotenv.sh is in $DOTENV_SH, passed as data rather than written into the script.
 */
function run(env: string, blocks: string[], body: string): string {
  fs.writeFileSync(path.join(dir, '.env'), env);
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${blocks.join('\n')}\n${body}`], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, DOTENV_SH: path.join(REPO_ROOT, 'scripts/lib/dotenv.sh') },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

/** Sources the real scripts/lib/dotenv.sh (from $DOTENV_SH, set by `run`), which reads .env with the repo's own dotenv. */
const sourceDotenv = () => 'ENV_FILE=.env\nsource "$DOTENV_SH"';

describe.skipIf(onWindows)('env_setting in scripts/lib/dotenv.sh', () => {
  // Each expected value comes from dotenv itself, so these can't drift from what the bot reads.
  it.each([
    'NAME=plain',
    'NAME = spaced',
    'NAME\t=\ttabbed',
    'export NAME=exported',
    '  export   NAME =  both  # comment',
    'NAME="quoted # kept"',
    "NAME=' single '",
    'NAME=first\nNAME = last',
    'NAME=`back # quoted`',
    'NAME="p\\"ss"',
    "NAME='it\\'s'",
    'NAME="unterminated',
    'NAME: colon',
    'export NAME:\t"colon # kept" # comment',
    'NAME=first\nNAME: last',
    // The cases the old bash parser read differently from dotenv (#920).
    'NAME:\n3001',
    'NAME="line1\\nline2"',
    'NAME="multi\nline"',
    'NAME=',
    'OTHER_NAME=x\nNAMESPACE=y',
    'NAME:x\nNAME : y',
  ])('reads %j as dotenv does', (env) => {
    const expected = dotenv.parse(`${env}\n`).NAME ?? '';
    expect(run(`${env}\n`, [sourceDotenv()], 'env_setting NAME')).toBe(expected);
  });

  it('reads the cases the old bash parser got wrong the way the bot does', () => {
    expect(run('NAME:\n3001\n', [sourceDotenv()], 'env_setting NAME')).toBe('3001');
    expect(run('NAME="line1\\nline2"\n', [sourceDotenv()], 'env_setting NAME')).toBe('line1\nline2');
    expect(run('NAME="multi\nline"\n', [sourceDotenv()], 'env_setting NAME')).toBe('multi\nline');
  });

  it('prints nothing, and succeeds under set -euo pipefail, for an unset or blank setting or a missing file', () => {
    expect(run('NAME=\n', [sourceDotenv()], 'printf "[%s]" "$(env_setting NAME)" "$(env_setting UNSET)"')).toBe('[][]');
    expect(run('', [sourceDotenv()], 'rm .env; printf "[%s]" "$(env_setting NAME)"')).toBe('[]');
  });

  it('ignores exported shell variables, reading only the file', () => {
    expect(run('NAME=from-file\n', [sourceDotenv()], 'export NAME=exported OTHER=exported; printf "%s|%s" "$(env_setting NAME)" "$(env_setting OTHER)"'))
      .toBe('from-file|');
  });
});

describe.skipIf(onWindows)('finding node and dotenv in scripts/lib/dotenv.sh', () => {
  let checkout: string;
  let tools: string;

  beforeEach(() => {
    // A checkout holding just the two scripts, so where dotenv comes from is up to each test.
    checkout = path.join(dir, 'checkout');
    fs.mkdirSync(path.join(checkout, 'scripts/lib'), { recursive: true });
    for (const file of ['scripts/lib/dotenv.sh', 'scripts/envSetting.js']) {
      fs.copyFileSync(path.join(REPO_ROOT, file), path.join(checkout, file));
    }
    // A PATH with the few tools dotenv.sh uses and no node on it.
    tools = path.join(dir, 'tools');
    fs.mkdirSync(tools);
    for (const tool of ['dirname', 'sed']) {
      fs.symlinkSync(spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim(), path.join(tools, tool));
    }
    fs.writeFileSync(path.join(dir, '.env'), 'NAME=value\n');
  });

  /** Links the real dotenv into the checkout's `folder` (node_modules or node_modules.old). */
  function linkDotenv(folder: string): void {
    fs.mkdirSync(path.join(checkout, folder));
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules/dotenv'), path.join(checkout, folder, 'dotenv'));
  }

  /**
   * Runs `script` in /bin/bash in the test directory, with node on PATH unless `env` says otherwise.
   * The checkout's dotenv.sh is in $DOTENV_SH, passed as data rather than written into the script,
   * since the temporary directory's path comes from $TMPDIR.
   */
  function bash(script: string, env: NodeJS.ProcessEnv = {}) {
    return spawnSync('/bin/bash', ['-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
        DOTENV_SH: path.join(checkout, 'scripts/lib/dotenv.sh'),
        ...env,
      },
    });
  }

  /** Sources the checkout's dotenv.sh under set -euo pipefail, then runs `body`. */
  function source(body: string, env: NodeJS.ProcessEnv = {}) {
    return bash(`set -euo pipefail\nENV_FILE=.env\nsource "$DOTENV_SH"\n${body}`, env);
  }

  it('reads with the checkout\'s node_modules dotenv', () => {
    linkDotenv('node_modules');
    expect(source('env_setting NAME').stdout).toBe('value');
  });

  it('falls back to node_modules.old while deploy.sh has the install moved aside', () => {
    linkDotenv('node_modules.old');
    expect(source('env_setting NAME').stdout).toBe('value');
  });

  it('stops the script, saying to run npm ci, when dotenv can\'t be loaded, never reading settings as unset', () => {
    const result = source('echo "carried on"');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("Can't load dotenv");
    expect(result.stderr).toContain('npm ci');
  });

  it('stops a subshell sourcing it even where bash ignores set -e (a function called from an if)', () => {
    const result = bash(`f() { ( set -euo pipefail; ENV_FILE=.env; source "$DOTENV_SH"; echo "read: $(env_setting NAME)" ); }
if out="$(f)"; then echo "ok: $out"; else echo "failed"; fi`);
    expect(result.stdout.trim()).toBe('failed');
  });

  it('returns a failure instead of exiting when DOTENV_RETURN_ON_FAILURE=1, so deploy.sh can roll back', () => {
    const result = bash(`ENV_FILE=.env\nif ! DOTENV_RETURN_ON_FAILURE=1 source "$DOTENV_SH"; then echo "rolling back"; fi`);
    expect(result.stdout.trim()).toBe('rolling back');
  });

  it('uses NODE_BIN, then node on PATH, then the node the systemd service runs', () => {
    linkDotenv('node_modules');
    // NODE_BIN wins, even over a node on PATH.
    expect(source('env_setting NAME', { NODE_BIN: path.join(dir, 'no-such-node') }).status).not.toBe(0);
    expect(source('env_setting NAME', { PATH: tools, NODE_BIN: process.execPath }).stdout).toBe('value');

    // No NODE_BIN and no node on PATH (cron's PATH, with node installed by nvm): the service's node.
    fs.writeFileSync(
      path.join(tools, 'systemctl'),
      `#!/bin/bash\n[ "$*" = "show -p ExecStart --value bcuk-bot" ] && echo "{ path=${process.execPath} ; argv[]=${process.execPath} dist/index.js }"\n`,
      { mode: 0o755 },
    );
    expect(source('env_setting NAME', { PATH: tools }).stdout).toBe('value');
  });

  it('says how to point it at node when none is found', () => {
    linkDotenv('node_modules');
    const result = source('env_setting NAME', { PATH: tools });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node not found');
    expect(result.stderr).toContain('NODE_BIN');
  });
});

describe.skipIf(onWindows)('deploy.sh health URL', () => {
  const blocks = () => [
    sourceDotenv(),
    scriptBlock('deploy.sh', 'WEB_PORT_SETTING=', /^HEALTH_URL=/),
  ];

  it.each([
    ['', 'http://127.0.0.1:3000/healthz'],
    ['WEB_HOST = 10.0.0.5\nWEB_PORT = 3001', 'http://10.0.0.5:3001/healthz'],
    ['export WEB_HOST=10.0.0.5', 'http://10.0.0.5:3000/healthz'],
    ['WEB_HOST=" 127.0.0.2 "', 'http://127.0.0.2:3000/healthz'],
    ['WEB_HOST="  "', 'http://127.0.0.1:3000/healthz'],
    ['WEB_HOST=0.0.0.0', 'http://127.0.0.1:3000/healthz'],
    ['WEB_HOST=::', 'http://[::1]:3000/healthz'],
    ['WEB_HOST=::1', 'http://[::1]:3000/healthz'],
    ['WEB_PORT=" 3001 "', 'http://127.0.0.1:3001/healthz'],
    ['WEB_HOST: 10.0.0.5\nWEB_PORT: 3001', 'http://10.0.0.5:3001/healthz'],
  ])('builds the URL for %j as %s', (env, expected) => {
    expect(run(`${env}\n`, blocks(), 'printf %s "$HEALTH_URL"')).toBe(expected);
  });
});

describe.skipIf(onWindows)('warn_if_env_readable_by_others in scripts/lib/dotenv.sh', () => {
  const warnBlock = () => scriptBlock('scripts/lib/dotenv.sh', 'warn_if_env_readable_by_others() {', /^}$/);

  /** Runs the check against `envFile` (relative to the test directory), returning what it printed to stderr. */
  function warn(envFile: string): string {
    const result = spawnSync('bash', ['-c', `set -euo pipefail\nENV_FILE="$1"\n${warnBlock()}\nwarn_if_env_readable_by_others`, 'bash', envFile], {
      cwd: dir,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stderr;
  }

  it('checks the file a symlinked .env points to, not the link itself', () => {
    fs.writeFileSync(path.join(dir, 'real.env'), 'A=1\n', { mode: 0o600 });
    fs.chmodSync(path.join(dir, 'real.env'), 0o600);
    fs.symlinkSync('real.env', path.join(dir, '.env'));
    expect(warn('.env')).toBe('');

    fs.chmodSync(path.join(dir, 'real.env'), 0o644);
    expect(warn('.env')).toContain('(mode 644)');
  });

  it('prints a chmod command that can be pasted as is for a path with spaces', () => {
    fs.mkdirSync(path.join(dir, 'my bot'));
    fs.writeFileSync(path.join(dir, 'my bot', '.env'), 'A=1\n');
    fs.chmodSync(path.join(dir, 'my bot', '.env'), 0o664);
    const printed = warn('my bot/.env');
    const command = /chmod 600 (.+)$/m.exec(printed)?.[1];
    expect(command).toBe('my\\ bot/.env');

    // Running the printed command makes the file private.
    const chmod = spawnSync('bash', ['-c', `chmod 600 ${command!}`], { cwd: dir });
    expect(chmod.status).toBe(0);
    expect(fs.statSync(path.join(dir, 'my bot', '.env')).mode & 0o777).toBe(0o600);
    expect(warn('my bot/.env')).toBe('');
  });

  it('says nothing for a missing file or a dangling symlink', () => {
    expect(warn('missing.env')).toBe('');
    fs.symlinkSync('nowhere.env', path.join(dir, '.env'));
    expect(warn('.env')).toBe('');
  });
});

