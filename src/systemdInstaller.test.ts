import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Runs scripts/install-systemd-service.sh against a copy of the repo, with stub sudo/systemctl/
// visudo on PATH, and checks the systemd unit it would install. The fake Node install lives under the
// test user's own home directory, like an nvm install, so the unit has to bind it back in.

const REPO_ROOT = path.resolve(__dirname, '..');
const onWindows = process.platform === 'win32';

const STUBS: Record<string, string> = {
  // `sudo install -m MODE SRC DEST` keeps SRC (the rendered unit or sudoers rule) for the test.
  sudo: `#!/usr/bin/env bash
if [ "$1" = install ]; then cp "$4" "$STATE/$(basename "$5")"; fi
exit 0
`,
  systemctl: '#!/usr/bin/env bash\nexit 0\n',
  // The installer refuses to run as root, which a CI container may be.
  id: '#!/usr/bin/env bash\necho botuser\n',
  visudo: '#!/usr/bin/env bash\nexit 0\n',
};

let root: string;
let repo: string;
let state: string;
let nodePrefix: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-unit-')));
  repo = path.join(root, 'repo');
  state = path.join(root, 'state');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'deploy'), { recursive: true });
  fs.mkdirSync(state);
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts/install-systemd-service.sh'), path.join(repo, 'scripts/install-systemd-service.sh'));
  fs.mkdirSync(path.join(repo, 'scripts/lib'));
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts/lib/dotenv.sh'), path.join(repo, 'scripts/lib/dotenv.sh'));
  fs.copyFileSync(path.join(REPO_ROOT, 'deploy/bcuk-bot.service'), path.join(repo, 'deploy/bcuk-bot.service'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ engines: { node: '>=1.0.0' } }));
  const stubs = path.join(root, 'stubs');
  fs.mkdirSync(stubs);
  for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(stubs, name), body, { mode: 0o755 });
  // An nvm-style Node install under the home directory: bin/node is a link to the real binary.
  nodePrefix = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.install-unit-node-')));
  fs.mkdirSync(path.join(nodePrefix, 'bin'));
  fs.symlinkSync(process.execPath, path.join(nodePrefix, 'bin', 'node'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(nodePrefix, { recursive: true, force: true });
});

/** Runs the installer with `env` as the checkout's .env, returning the rendered unit file. */
function install(env: string): string {
  fs.writeFileSync(path.join(repo, '.env'), env);
  const result = spawnSync('bash', [path.join(repo, 'scripts/install-systemd-service.sh')], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      STATE: state,
      PATH: `${path.join(root, 'stubs')}:${path.join(nodePrefix, 'bin')}:${process.env.PATH ?? ''}`,
    },
  });
  if (result.status !== 0) throw new Error(`installer failed:\n${result.stdout}\n${result.stderr}`);
  return fs.readFileSync(path.join(state, 'bcuk-bot.service'), 'utf8');
}

/** The value of `key=` in a unit file. */
function setting(unit: string, key: string): string | undefined {
  return unit.split('\n').find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
}

describe.skipIf(onWindows)('install-systemd-service.sh', () => {
  it('hides home directories and binds back only the checkout, the Node install and the writable folders', () => {
    const videos = path.join(root, 'videos');
    const unit = install(`OVERLAY_FOLDER=${videos} # absolute\nSFX_FOLDER=" ./my-sfx "\n`);

    expect(setting(unit, 'ProtectHome')).toBe('tmpfs');
    expect(setting(unit, 'ProtectSystem')).toBe('strict');
    expect(setting(unit, 'BindReadOnlyPaths')).toBe(`"${repo}" "${nodePrefix}"`);
    expect(setting(unit, 'BindPaths')).toBe(
      `"-${repo}/logs" "-${videos}" "-${repo}/alert-assets" "-${repo}/my-sfx" "-${repo}/upload-incoming"`,
    );
    // ReadWritePaths can't reach under the hidden /home; everything writable is a bind instead.
    expect(setting(unit, 'ReadWritePaths')).toBeUndefined();
    expect(setting(unit, 'ExecStart')).toBe(`${path.join(nodePrefix, 'bin', 'node')} dist/index.js`);
    expect(unit).not.toMatch(/__(USER|REPO_DIR|NODE_BIN|READONLY_PATHS|WRITABLE_PATHS)__/);
  });

  it('binds the Node install once when its link and real path share a prefix', () => {
    // Replace the link with a real file, so the path the unit names is also the real path.
    const node = path.join(nodePrefix, 'bin', 'node');
    fs.rmSync(node);
    fs.copyFileSync(process.execPath, node);
    fs.chmodSync(node, 0o755);

    expect(setting(install(''), 'BindReadOnlyPaths')).toBe(`"${repo}" "${nodePrefix}"`);
  });

  it('refuses a folder path the unit cannot express', () => {
    expect(() => install(`OVERLAY_FOLDER=${root}/100%videos\n`)).toThrow(/can't express/);
  });
});
