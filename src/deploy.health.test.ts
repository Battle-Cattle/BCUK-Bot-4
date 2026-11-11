import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SCRIPT_TEST_TIMEOUT_MS, deploy, failureReport, notLinux, pushV2, read, restarts, sandbox, useSandbox, workHead } from './test-utils/deploySandbox';

/** End-to-end tests for deploy.sh: health. Linux only; see deploySandbox.ts. */
describe.skipIf(notLinux)('deploy.sh (health)', { timeout: SCRIPT_TEST_TIMEOUT_MS }, () => {
  useSandbox();

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

  it('sends every health probe straight to the bot, never through a proxy', () => {
    pushV2();
    // A proxy the deploy shell has set would otherwise carry the probe and could fail it.
    expect(deploy({ http_proxy: 'http://proxy.invalid:3128', HTTP_PROXY: 'http://proxy.invalid:3128' }).status).toBe(0);

    const calls = read(path.join(sandbox.state, 'curl-args')).split('\n').filter(Boolean);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/(^| )--noproxy \* /);
  });

  it("health-checks the WEB_PORT the bot reads, including `export` and spaces around '='", () => {
    fs.appendFileSync(path.join(sandbox.work, '.env'), 'WEB_PORT=3000\nexport WEB_PORT = 3001 # panel\n');
    pushV2();

    expect(deploy().status).toBe(0);
    const urls = read(path.join(sandbox.state, 'curl-urls')).split('\n');
    expect(new Set(urls)).toEqual(new Set(['http://127.0.0.1:3001/healthz']));
  });

  it('fails and rolls back when another process holds the web port', () => {
    pushV2();
    const result = deploy({ SS_PID: '999' });

    expect(result.status).toBe(1);
    expect(failureReport()).toContain('port 3000 is held by PID 999, not bcuk-bot (MainPID 4242)');
    expect(read(path.join(sandbox.work, 'dist/marker'))).toBe('v1');
  });

  it('catches an outage inside the stability window, not just at its end', () => {
    pushV2();
    // Call 1 is the first health check; call 2 is the stability loop's first probe.
    const result = deploy({ DEPLOY_STABILITY_SECONDS: '0.3', CURL_FAIL_CALL: '2' });

    expect(result.status).toBe(1);
    expect(failureReport()).toContain('stopped answering within 0.3s');
    expect(restarts()).toEqual(['v2', 'v1']);
    expect(failureReport()).toContain('Rolled back');
  });

  it('honours a fractional health timeout instead of rounding it to whole seconds', () => {
    pushV2();
    const started = Date.now();
    const result = deploy({ UNHEALTHY_BUILDS: 'v1 v2', DEPLOY_HEALTH_TIMEOUT_SECONDS: '0.4' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("didn't answer http://127.0.0.1:3000/healthz within 0.4s");
    // Two waits (the new build, then the previous one) of 0.4s each: far below the 1-2s each that
    // whole-second deadlines cost.
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('never sleeps past the health timeout, however long the poll interval', () => {
    pushV2();
    const started = Date.now();
    // Without the cap each wait would sleep the full 5s before noticing its 0.3s deadline had passed.
    const result = deploy({ UNHEALTHY_BUILDS: 'v1 v2', DEPLOY_POLL_INTERVAL_SECONDS: '5' });

    expect(result.status).toBe(1);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('ends the stability window on time, however long the poll interval, and still checks at its end', () => {
    pushV2();
    const started = Date.now();
    // Call 1 is the health check; call 2 is the check at the end of the 0.3s window, which fails.
    const result = deploy({ DEPLOY_STABILITY_SECONDS: '0.3', DEPLOY_POLL_INTERVAL_SECONDS: '5', CURL_FAIL_CALL: '2' });

    expect(result.status).toBe(1);
    expect(failureReport()).toContain('stopped answering within 0.3s');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it.each(['abc', '-1', '1e3', '1.2.3'])("refuses a timeout or interval of '%s' before changing anything", (bad) => {
    const before = workHead();
    pushV2();
    for (const name of ['DEPLOY_HEALTH_TIMEOUT_SECONDS', 'DEPLOY_STABILITY_SECONDS', 'DEPLOY_POLL_INTERVAL_SECONDS']) {
      const result = deploy({ [name]: bad });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`'${bad}' isn't a number of seconds`);
      expect(restarts()).toEqual([]);
      expect(workHead()).toBe(before);
    }
  });

  it("keeps deploy.sh's production defaults: 1s poll, 90s health timeout, 30s stability window", () => {
    const script = fs.readFileSync(path.join(sandbox.work, 'deploy.sh'), 'utf8');

    expect(script).toMatch(/^POLL_INTERVAL_SECONDS="\$\{DEPLOY_POLL_INTERVAL_SECONDS:-1\}"$/m);
    expect(script).toMatch(/^HEALTH_TIMEOUT_SECONDS="\$\{DEPLOY_HEALTH_TIMEOUT_SECONDS:-90\}"$/m);
    expect(script).toMatch(/^STABILITY_SECONDS="\$\{DEPLOY_STABILITY_SECONDS:-30\}"$/m);
  });
});
