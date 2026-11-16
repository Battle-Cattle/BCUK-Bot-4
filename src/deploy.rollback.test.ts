import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SCRIPT_TEST_TIMEOUT_MS, deploy, failureReport, notLinux, pushV2, read, restarts, sandbox, useSandbox, workHead, write } from './test-utils/deploySandbox';

/** End-to-end tests for deploy.sh: rollback. Linux only; see deploySandbox.ts. */
describe.skipIf(notLinux)('deploy.sh (rollback)', { timeout: SCRIPT_TEST_TIMEOUT_MS }, () => {
  useSandbox();

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

  it('puts back a previous build an earlier deploy moved aside and was cut off before replacing', () => {
    // Cut off (say, by a power cut) between `mv dist dist.old` and the new build landing.
    fs.renameSync(path.join(sandbox.work, 'dist'), path.join(sandbox.work, 'dist.old'));
    pushV2();
    const result = deploy({ NPM_TEST_EXIT: '1' });

    expect(result.stdout).toContain('there is no dist/. Moving dist.old/ back.');
    // The failed deploy rolled back onto that build instead of finding none.
    expect(read(path.join(sandbox.work, 'dist/marker'))).toBe('v1');
    expect(fs.existsSync(path.join(sandbox.work, 'dist.old'))).toBe(false);
  });

  it('puts back the previous dependencies when an earlier deploy was cut off mid-install', () => {
    // Cut off during `npm ci`: node_modules holds a partial install with no hidden lockfile yet.
    fs.renameSync(path.join(sandbox.work, 'node_modules'), path.join(sandbox.work, 'node_modules.old'));
    write(path.join(sandbox.work, 'node_modules/partial'), '');
    const result = deploy({ NPM_TEST_EXIT: '1' });

    expect(result.stdout).toContain('node_modules/ is incomplete (no .package-lock.json). Moving node_modules.old/ back.');
    expect(read(path.join(sandbox.work, 'node_modules/marker'))).toBe('v1');
    expect(fs.existsSync(path.join(sandbox.work, 'node_modules/partial'))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.work, 'node_modules.old'))).toBe(false);
  });

  it('replaces stale .old copies as usual when the current folders are complete', () => {
    write(path.join(sandbox.work, 'dist.old/marker'), 'v0\n');
    write(path.join(sandbox.work, 'node_modules.old/marker'), 'v0\n');
    pushV2();
    const result = deploy();

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Moving');
    expect(read(path.join(sandbox.work, 'dist/marker'))).toBe('v2');
    expect(fs.existsSync(path.join(sandbox.work, 'dist.old'))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.work, 'node_modules.old'))).toBe(false);
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

  it('rolls back a failed restart when the deploy adds no migrations', () => {
    const before = workHead();
    pushV2();
    const result = deploy({ UNHEALTHY_BUILDS: 'v2' });

    expect(result.status).toBe(1);
    expect(workHead()).toBe(before);
    expect(restarts()).toEqual(['v2', 'v1']);
    expect(failureReport()).toContain('Rolled back');
  });
});
