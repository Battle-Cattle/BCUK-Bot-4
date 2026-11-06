import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// deploy.sh, the systemd installer and the backup scripts all read .env with env_setting from
// scripts/lib/dotenv.sh, which must parse a line the way dotenv (and so the bot) does. These tests
// run it, and deploy.sh's health-URL block, against sample files.

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

/** Runs `body` in bash after the given script blocks, in a directory holding `env` as its .env. */
function run(env: string, blocks: string[], body: string): string {
  fs.writeFileSync(path.join(dir, '.env'), env);
  const result = spawnSync('bash', ['-c', `set -euo pipefail\nREPO_DIR="${dir}"\n${blocks.join('\n')}\n${body}`], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

describe.skipIf(onWindows)('env_setting in scripts/lib/dotenv.sh', () => {
  const envSetting = () => `ENV_FILE=.env\n${scriptBlock('scripts/lib/dotenv.sh', 'env_setting() {', /^}$/)}`;

  it.each([
    ['NAME=plain', 'plain'],
    ['NAME = spaced', 'spaced'],
    ['NAME\t=\ttabbed', 'tabbed'],
    ['export NAME=exported', 'exported'],
    ['  export   NAME =  both  # comment', 'both'],
    ['NAME="quoted # kept"', 'quoted # kept'],
    ["NAME=' single '", ' single '],
    ['NAME=first\nNAME = last', 'last'],
    ['NAME=`back # quoted`', 'back # quoted'],
    ['NAME="p\\"ss"', 'p\\"ss'],
    ["NAME='it\\'s'", "it\\'s"],
    ['NAME="unterminated', '"unterminated'],
    ['NAME: colon', 'colon'],
    ['export NAME:\t"colon # kept" # comment', 'colon # kept'],
    ['NAME=first\nNAME: last', 'last'],
  ])('reads %j as %j', (line, expected) => {
    expect(run(`${line}\n`, [envSetting()], 'env_setting NAME')).toBe(expected);
  });

  it('ignores other settings that merely contain the name', () => {
    expect(run('OTHER_NAME=x\nNAMESPACE=y\n', [envSetting()], 'env_setting NAME')).toBe('');
  });

  it('ignores colon lines dotenv ignores: no whitespace after the colon, or space before it', () => {
    expect(run('NAME:x\nNAME : y\n', [envSetting()], 'env_setting NAME')).toBe('');
  });
});

describe.skipIf(onWindows)('deploy.sh health URL', () => {
  const blocks = () => [
    'ENV_FILE=.env',
    scriptBlock('scripts/lib/dotenv.sh', 'env_setting() {', /^}$/),
    scriptBlock('scripts/lib/dotenv.sh', 'trim() {', /^}$/),
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
