import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { SCRIPT_TEST_TIMEOUT_MS, commitVersion, createSandbox, isRunning, notLinux, read, removeTemplate, run, write } from './deploySandbox';

describe.skipIf(notLinux)('deploySandbox', { timeout: SCRIPT_TEST_TIMEOUT_MS }, () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    removeTemplate();
  });

  /** Creates a sandbox and remembers its directory for cleanup. */
  function make() {
    const made = createSandbox();
    roots.push(made.root);
    return made;
  }

  it('gives each copy remotes and a backup folder inside its own directory', () => {
    const a = make();
    const b = make();

    expect(a.root).not.toBe(b.root);
    for (const copy of [a, b]) {
      expect(run('git', ['config', 'remote.origin.url'], copy.work, copy.env).trim()).toBe(copy.origin);
      expect(run('git', ['config', 'remote.origin.url'], copy.dev, copy.env).trim()).toBe(copy.origin);
      expect(read(path.join(copy.work, '.env'))).toContain(`BACKUP_DIR=${copy.backups}`);
      expect(copy.env.STATE).toBe(copy.state);
    }
  });

  it("keeps a commit pushed from one copy out of another copy's origin", () => {
    const a = make();
    const b = make();
    // commitVersion works on the most recently created sandbox, which is `b`.
    commitVersion('only-in-b');

    expect(run('git', ['log', '--format=%s', '-1'], b.origin, b.env).trim()).toBe('only-in-b');
    expect(run('git', ['log', '--format=%s', '-1'], a.origin, a.env).trim()).toBe('v1');
  });

  it("keeps state written in one copy out of another's", () => {
    const a = make();
    const b = make();
    write(path.join(a.state, 'restarts'), 'v9\n');

    expect(read(path.join(b.state, 'restarts'))).toBe('');
    expect(read(path.join(b.state, 'running'))).toBe('v1');
  });

  it('starts every copy as a clean v1 checkout with its dist and node_modules marked v1', () => {
    const copy = make();

    expect(run('git', ['status', '--porcelain'], copy.work, copy.env)).toBe('');
    expect(read(path.join(copy.work, 'dist/marker'))).toBe('v1');
    expect(read(path.join(copy.work, 'node_modules/marker'))).toBe('v1');
    expect(read(path.join(copy.state, 'applied-migrations'))).toBe('0001_baseline');
  });

  it('removes the template and builds a new one on the next use', () => {
    const first = make();
    removeTemplate();
    const second = make();

    expect(fs.existsSync(first.root)).toBe(true);
    expect(second.root).not.toBe(first.root);
    expect(run('git', ['config', 'remote.origin.url'], second.work, second.env).trim()).toBe(second.origin);
  });

  it('reports a live process as running and a missing one as not', () => {
    expect(isRunning(process.pid)).toBe(true);
    // PIDs above the kernel's maximum (2^22) can't exist.
    expect(isRunning(2 ** 22 + 1)).toBe(false);
  });

  it('reports a process that has exited as not running, whether or not it has been reaped yet', async () => {
    const child = spawn('true');
    const pid = child.pid!;
    await new Promise((resolve) => child.once('exit', resolve));

    expect(isRunning(pid)).toBe(false);
  });
});
