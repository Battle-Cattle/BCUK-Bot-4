import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SCRIPT_TEST_TIMEOUT_MS, deploy, failureReport, isRunning, notLinux, pushV2, read, sandbox, useSandbox, workHead } from './test-utils/deploySandbox';

/** End-to-end tests for deploy.sh: interrupt. Linux only; see deploySandbox.ts. */
describe.skipIf(notLinux)('deploy.sh (interrupt)', { timeout: SCRIPT_TEST_TIMEOUT_MS }, () => {
  useSandbox();

  it('rolls back when the deploy is interrupted', () => {
    const before = workHead();
    pushV2();
    const result = deploy({ NPM_TEST_SIGNAL: '1' });

    expect(result.status).toBe(1);
    expect(workHead()).toBe(before);
    expect(read(path.join(sandbox.work, 'node_modules/marker'))).toBe('v1');
    expect(fs.existsSync(path.join(sandbox.work, 'node_modules.old'))).toBe(false);
    expect(failureReport()).toContain('the deploy was interrupted');
  });

  it('stops a build still running in the background before rolling back an interrupted deploy', () => {
    pushV2();
    const result = deploy({ NPM_TEST_SIGNAL: '1', NPM_BUILD_HANG: '1' });

    expect(result.status).toBe(1);
    const child = Number(read(path.join(sandbox.state, 'build-child')));
    expect(child).toBeGreaterThan(0);
    // The build's own child was stopped, not left running against the restored checkout. A killed
    // orphan can linger as a zombie until init reaps it, which still counts as stopped.
    expect(isRunning(child)).toBe(false);
    expect(fs.existsSync(path.join(sandbox.work, 'dist.new'))).toBe(false);
    expect(read(path.join(sandbox.work, 'dist/marker'))).toBe('v1');
  });

  it('kills a build process that ignores TERM instead of letting the rollback hang on it', () => {
    pushV2();
    const started = Date.now();
    const result = deploy({ NPM_TEST_SIGNAL: '1', NPM_BUILD_HANG: 'ignore-term', DEPLOY_JOB_STOP_TIMEOUT_SECONDS: '1' });

    expect(result.status).toBe(1);
    expect(isRunning(Number(read(path.join(sandbox.state, 'build-child'))))).toBe(false);
    // Well short of the child's 30s sleep: the rollback gave up waiting and killed it.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(read(path.join(sandbox.work, 'dist/marker'))).toBe('v1');
  });

  it.each(['node_modules', 'dist'])('puts %s back when an interrupt lands right after moving it aside', (folder) => {
    const before = workHead();
    pushV2();
    const result = deploy({ MV_INTERRUPT: folder });

    expect(result.status).toBe(1);
    expect(workHead()).toBe(before);
    expect(read(path.join(sandbox.work, folder, 'marker'))).toBe('v1');
    expect(fs.existsSync(path.join(sandbox.work, `${folder}.old`))).toBe(false);
    expect(failureReport()).toContain('the deploy was interrupted');
  });
});
