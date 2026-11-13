import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Runs scripts/install-systemd-service.sh against a copy of the repo, with stub sudo/systemctl/
// visudo on PATH, and checks the systemd unit it would install. The fake Node install lives under the
// test user's own home directory, like an nvm install, so the unit has to bind it back in.

const REPO_ROOT = path.resolve(__dirname, '..');
// The installer is for systemd, so Linux only, and it needs a `realpath` with `-m` (GNU coreutils;
// BusyBox's may lack it). It binds a Node install back into the sandbox only from under /home or
// /root, so the fake one made under the home directory is only bound when the home directory is
// there too (not, say, HOME=/github/home).
/** The home directory with links resolved, or '' when it doesn't exist (so the suite skips). */
function realHome(): string {
  try {
    return fs.realpathSync(os.homedir());
  } catch {
    return '';
  }
}
const canRunInstaller =
  process.platform === 'linux' &&
  /^\/(home|root)\//.test(`${realHome()}/`) &&
  spawnSync('bash', ['-c', 'realpath -m /nonexistent/realpath-probe'], { stdio: 'ignore' }).status === 0;

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

/**
 * Runs the installer with `env` as the checkout's .env (given `envMode`), returning the rendered
 * unit file and what the installer printed to stderr.
 */
function runInstaller(env: string, nodeBinDir = path.join(nodePrefix, 'bin'), envMode = 0o600): { unit: string; stderr: string } {
  const envFile = path.join(repo, '.env');
  fs.writeFileSync(envFile, env);
  fs.chmodSync(envFile, envMode);
  const result = spawnSync('bash', [path.join(repo, 'scripts/install-systemd-service.sh')], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      STATE: state,
      PATH: `${path.join(root, 'stubs')}:${nodeBinDir}:${process.env.PATH ?? ''}`,
    },
  });
  if (result.status !== 0) throw new Error(`installer failed:\n${result.stdout}\n${result.stderr}`);
  return { unit: fs.readFileSync(path.join(state, 'bcuk-bot.service'), 'utf8'), stderr: result.stderr };
}

/** Runs the installer with `env` as the checkout's .env, returning the rendered unit file. */
function install(env: string, nodeBinDir = path.join(nodePrefix, 'bin')): string {
  return runInstaller(env, nodeBinDir).unit;
}

/** The value of `key=` in a unit file. */
function setting(unit: string, key: string): string | undefined {
  return unit.split('\n').find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
}

describe.skipIf(!canRunInstaller)('install-systemd-service.sh', () => {
  it('hides home directories and binds back only the checkout, the node binary and the writable folders', () => {
    const videos = path.join(root, 'videos');
    const unit = install(`OVERLAY_FOLDER=${videos} # absolute\nSFX_FOLDER=" ./my-sfx "\n`);

    expect(setting(unit, 'ProtectHome')).toBe('tmpfs');
    expect(setting(unit, 'ProtectSystem')).toBe('strict');
    // The node binary, not the install folder it's in.
    expect(setting(unit, 'BindReadOnlyPaths')).toBe(`"${repo}" "${path.join(nodePrefix, 'bin', 'node')}"`);
    expect(setting(unit, 'BindPaths')).toBe(
      `"-${repo}/logs" "-${videos}" "-${repo}/alert-assets" "-${repo}/my-sfx" "-${repo}/upload-incoming"`,
    );
    // ReadWritePaths can't reach under the hidden /home; everything writable is a bind instead.
    expect(setting(unit, 'ReadWritePaths')).toBeUndefined();
    expect(setting(unit, 'ExecStart')).toBe(`${path.join(nodePrefix, 'bin', 'node')} dist/index.js`);
    expect(unit).not.toMatch(/__(USER|REPO_DIR|NODE_BIN|READONLY_PATHS|WRITABLE_PATHS)__/);
  });

  it('binds the node binary once when the path the unit names is its real path', () => {
    // Replace the link with a real file, so the path the unit names is also the real path. Copied by
    // a separate `cp` process: copying it here would hold a write handle on it in this multi-threaded
    // process, which a child another test spawns at that moment can inherit, and Linux then refuses
    // to run the file ("Text file busy").
    const node = path.join(nodePrefix, 'bin', 'node');
    fs.rmSync(node);
    const copied = spawnSync('cp', [process.execPath, node]);
    if (copied.status !== 0) throw new Error(`cp failed: ${String(copied.stderr)}`);

    expect(setting(install(''), 'BindReadOnlyPaths')).toBe(`"${repo}" "${node}"`);
  });

  it('binds the link and the file it resolves to when both are in a home directory, never their folders', () => {
    // Like ~/.local/bin/node linking to a binary elsewhere in the home directory: each folder can
    // hold unrelated files, so only the two node files are bound.
    const real = path.join(nodePrefix, 'shared', 'bin', 'node');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    const copied = spawnSync('cp', [process.execPath, real]);
    if (copied.status !== 0) throw new Error(`cp failed: ${String(copied.stderr)}`);
    const link = path.join(nodePrefix, 'bin', 'node');
    fs.rmSync(link);
    fs.symlinkSync(real, link);

    expect(setting(install(''), 'BindReadOnlyPaths')).toBe(`"${repo}" "${link}" "${real}"`);
  });

  it.each(['100%videos', 'videos:ro', 'say"hi'])('refuses a folder path the unit cannot express (%s)', (name) => {
    expect(() => install(`OVERLAY_FOLDER='${root}/${name}'\n`)).toThrow(/can't express/);
  });

  it('adds the second round of sandbox settings (#958), and never an active MemoryDenyWriteExecute', () => {
    const unit = install('');
    expect(setting(unit, 'CapabilityBoundingSet')).toBe('');
    expect(setting(unit, 'AmbientCapabilities')).toBe('');
    expect(setting(unit, 'SystemCallArchitectures')).toBe('native');
    expect(setting(unit, 'SystemCallFilter')).toBe('@system-service');
    expect(setting(unit, 'SystemCallErrorNumber')).toBe('EPERM');
    expect(setting(unit, 'RestrictAddressFamilies')).toBe('AF_INET AF_INET6 AF_UNIX');
    expect(setting(unit, 'PrivateDevices')).toBe('true');
    expect(setting(unit, 'ProtectClock')).toBe('true');
    expect(setting(unit, 'ProtectProc')).toBe('invisible');
    expect(setting(unit, 'ProcSubset')).toBe('pid');
    expect(setting(unit, 'UMask')).toBe('0077');
    expect(setting(unit, 'RemoveIPC')).toBe('true');
    // V8's JIT needs writable+executable memory: the comment saying so stays, the setting never appears.
    expect(setting(unit, 'MemoryDenyWriteExecute')).toBeUndefined();
    expect(unit).toContain('# Not MemoryDenyWriteExecute=true');
  });

  it.each([0o664, 0o644, 0o640])('warns about a .env readable by group or others (mode %o), and still installs', (mode) => {
    const { unit, stderr } = runInstaller('', path.join(nodePrefix, 'bin'), mode);
    expect(stderr).toContain(`WARNING: ${repo}/.env is readable by other users on this host (mode ${mode.toString(8)})`);
    expect(stderr).toContain(`chmod 600 ${repo}/.env`);
    expect(unit).toContain('[Service]');
  });

  it.each([0o600, 0o400])('says nothing about a private .env (mode %o)', (mode) => {
    const { stderr } = runInstaller('', path.join(nodePrefix, 'bin'), mode);
    expect(stderr).not.toContain('WARNING');
  });
});

// `systemd-analyze verify` catches an unknown or misspelt setting. It needs systemd on the test host,
// and checks the rendered unit with the placeholders filled by the test's own values.
const canVerifyUnit =
  canRunInstaller && spawnSync('systemd-analyze', ['--version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!canVerifyUnit)('bcuk-bot.service under systemd-analyze verify', () => {
  it('has no unknown or invalid settings', () => {
    const unitDir = path.join(root, 'units');
    fs.mkdirSync(unitDir);
    const unitPath = path.join(unitDir, 'bcuk-bot.service');
    fs.writeFileSync(unitPath, install(''));
    const result = spawnSync('systemd-analyze', ['verify', '--man=no', unitPath], { encoding: 'utf8' });
    // Warnings about the host (a missing user, a dependency unit it lacks, the binary's path) are
    // fine here; an unknown lvalue or a value systemd can't parse is what this is for.
    expect(result.stderr).not.toMatch(/Unknown (key|lvalue)|Failed to parse|Invalid|unknown/i);
  });
});
