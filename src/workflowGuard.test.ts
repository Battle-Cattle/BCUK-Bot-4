// Tests for the main session's workflow hooks: .claude/hooks/workflow-guard.mjs (blocks a commit,
// push or ready-for-review that skipped a required step), .claude/hooks/workflow-state.mjs (the
// markers those steps leave) and .claude/skills/precommit/precommit.mjs (the checks that write
// the precommit marker). Each test drives the real scripts as Claude Code does, through stdin
// and exit codes, against a throwaway git repository with its own origin.
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, '.claude/hooks/workflow-guard.mjs');
const STATE = path.join(ROOT, '.claude/hooks/workflow-state.mjs');
const PRECOMMIT = path.join(ROOT, '.claude/skills/precommit/precommit.mjs');
// The hooks run in Linux cloud sessions and on developers' Unix machines; the fake npm scripts
// and shell quoting below assume a POSIX shell.
const isWindows = process.platform === 'win32';

let repo: string;
let origin: string;

/** Runs git in the test repository. */
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Writes a file in the test repository, creating its folder. */
function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
}

/** Commits everything in the test repository, bypassing the hooks (they aren't installed there). */
function commitAll(message: string): void {
  git('add', '-A');
  git('commit', '-qm', message);
}

/** Runs the guard as a hook with the given input, returning its exit code and output. */
function hook(mode: 'pre' | 'notify', input: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('node', [GUARD, mode], {
    input: JSON.stringify({ cwd: repo, ...input }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_WORKFLOW_GUARD: '', ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs the guard on a Bash command. */
function bash(command: string, env: NodeJS.ProcessEnv = {}) {
  return hook('pre', { tool_name: 'Bash', tool_input: { command } }, env);
}

/** Runs a script from the repository against the test repository. */
function runScript(script: string, ...args: string[]) {
  const result = spawnSync('node', [script, ...args], { cwd: repo, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Runs precommit.mjs with a fake `npx` first on PATH, so its changed-tests and ESLint steps run
 * offline. The fake records each call's arguments to npx.log and exits with `npxExit`.
 */
function runPrecommitWithFakeNpx(npxExit: number, ...args: string[]) {
  return runPrecommitWithFakeNpxIn({}, PRECOMMIT, npxExit, ...args);
}

/** Like runPrecommitWithFakeNpx, running the given copy of precommit.mjs with extra environment variables. */
function runPrecommitWithFakeNpxIn(env: NodeJS.ProcessEnv, script: string, npxExit: number, ...args: string[]) {
  const bin = path.join(path.dirname(repo), 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(path.dirname(repo), 'npx.log');
  fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\necho "$@" >> "${log}"\nexit ${npxExit}\n`, { mode: 0o755 });
  const result = spawnSync('node', [script, ...args], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  return { status: result.status, stdout: result.stdout, calls };
}

/** Writes a package.json whose typecheck and test scripts exit with the given codes. */
function fakeScripts(typecheck: number, test: number): void {
  write('package.json', JSON.stringify({
    name: 'fixture',
    scripts: { typecheck: `node -e "process.exit(${typecheck})"`, test: `node -e "process.exit(${test})"` },
  }));
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-guard-'));
  origin = path.join(tmp, 'origin.git');
  repo = path.join(tmp, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', origin);
  write('package.json', '{"name":"fixture"}');
  write('notes.md', 'one\n');
  write('src/index.ts', 'export {};\n');
  write('src/feature.ts', 'export const a = 1;\n');
  commitAll('initial');
  git('push', '-q', 'origin', 'main');
  git('checkout', '-q', '-b', 'feature');
  // An uncommitted package.json change keeps precommit on its full-suite path, which runs these
  // fake scripts; the tests change only files ESLint doesn't check, so no real tool runs here.
  fakeScripts(0, 0);
});

afterEach(() => {
  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
});

describe.skipIf(isWindows)('workflow-guard pre: commits', () => {
  it('lets a Bash command that is not a commit or push through', () => {
    expect(bash('ls -la && git status').status).toBe(0);
  });

  it('blocks a commit when precommit has never passed', () => {
    write('notes.md', 'two\n');
    const result = bash('git add -A && git commit -m "change"');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no precommit run is recorded');
    expect(result.stderr).toContain('precommit.mjs');
  });

  it('allows a commit of exactly the tree precommit checked, staged in the same command', () => {
    write('notes.md', 'two\n');
    expect(runScript(PRECOMMIT).status).toBe(0);
    expect(bash('git add -A && git commit -m "change"').status).toBe(0);
  });

  it('blocks the commit again once a file changes after precommit passed', () => {
    write('notes.md', 'two\n');
    expect(runScript(PRECOMMIT).status).toBe(0);
    write('notes.md', 'three\n');
    const result = bash('git commit -am "change"');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('files changed since precommit last passed');
  });

  it('blocks a commit that shares its command line with something that could change the files', () => {
    write('notes.md', 'two\n');
    expect(runScript(PRECOMMIT).status).toBe(0);
    const result = bash("sed -i 's/two/three/' notes.md && git add -A && git commit -m x");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('in its own Bash call');
    expect(bash('npm run lint; git commit -m x').status).toBe(2);
    expect(bash(`cd ${repo} && git status && git add -A && git commit -m x`).status).toBe(0);
  });

  it('counts a new untracked file as a change', () => {
    expect(runScript(PRECOMMIT).status).toBe(0);
    write('src/new.ts', 'export const b = 1;\n');
    expect(bash('git add -A && git commit -m "add"').status).toBe(2);
  });

  it('ignores "git commit" inside quotes, and git commit-tree', () => {
    expect(bash('grep -rn "git commit" .claude').status).toBe(0);
    expect(bash("echo 'git commit -m x'").status).toBe(0);
    expect(bash('git commit-tree HEAD^{tree} -m x').status).toBe(0);
  });

  it('ignores git commands inside a heredoc body, but not a commit that reads its message from one', () => {
    expect(bash("cat > x.sh <<'EOF'\ngit add -A; git commit -qm i\nEOF\nbash x.sh").status).toBe(0);
    expect(bash('git commit -F - <<EOF\nmessage\nEOF').status).toBe(2);
  });

  it('checks the repository named by git -C', () => {
    const result = hook('pre', { tool_name: 'Bash', tool_input: { command: `git -C ${repo} commit -m x` }, cwd: os.tmpdir() });
    expect(result.status).toBe(2);
  });

  it('checks the repository an earlier cd moves to', () => {
    const outside = hook('pre', { tool_name: 'Bash', tool_input: { command: `cd ${os.tmpdir()} && git commit -m x` } });
    expect(outside.status).toBe(0); // not a repository: the check is skipped
    const inside = hook('pre', { tool_name: 'Bash', tool_input: { command: `cd ${repo} && git commit -m x` }, cwd: os.tmpdir() });
    expect(inside.status).toBe(2);
  });

  it('lets everything through when CLAUDE_WORKFLOW_GUARD=off', () => {
    expect(bash('git commit -m x', { CLAUDE_WORKFLOW_GUARD: 'off' }).status).toBe(0);
  });

  it('lets the call through when the check itself fails (not a git repository)', () => {
    const result = hook('pre', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: os.tmpdir() });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('workflow-guard skipped its check');
  });
});

describe.skipIf(isWindows)('workflow-guard pre: advisor before push', () => {
  it('allows a push that changes no advisor-sensitive file', () => {
    write('src/feature.ts', 'export const a = 2;\n');
    commitAll('feature');
    expect(bash('git push -u origin feature').status).toBe(0);
  });

  it.each(['src/index.ts', 'migrations/099_x.sql', 'src/web/middleware.ts', 'src/web/server.ts', 'src/shared/crypto.ts'])(
    'blocks a push that changes %s until the advisor consult is recorded',
    (file) => {
      write(file, '// changed\n');
      commitAll('sensitive');
      const blocked = bash('git push -u origin feature');
      expect(blocked.status).toBe(2);
      expect(blocked.stderr).toContain(file);
      expect(blocked.stderr).toContain('record advisor');
      expect(runScript(STATE, 'record', 'advisor').status).toBe(0);
      expect(bash('git push -u origin feature').status).toBe(0);
    },
  );

  it('needs a new consult when the sensitive diff changes after one was recorded', () => {
    write('src/index.ts', 'export const x = 1;\n');
    commitAll('one');
    runScript(STATE, 'record', 'advisor');
    write('src/index.ts', 'export const x = 2;\n');
    commitAll('two');
    expect(bash('git push').status).toBe(2);
  });

  it('keeps the consult when only non-sensitive files change afterwards', () => {
    write('src/index.ts', 'export const x = 1;\n');
    commitAll('one');
    runScript(STATE, 'record', 'advisor');
    write('src/feature.ts', 'export const a = 9;\n');
    commitAll('two');
    expect(bash('git push').status).toBe(0);
  });

  it('blocks a push that shares its command line with a commit, since the hook sees HEAD from before it', () => {
    expect(runScript(PRECOMMIT).status).toBe(0); // the commit itself would be allowed
    const result = bash('git commit -qm x && git push');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('`git push` in its own Bash call');
    expect(bash('git fetch -q origin main && git push -u origin feature').status).toBe(0);
  });

  it('applies to create_pull_request too, until the consult is recorded', () => {
    write('src/index.ts', 'export const x = 1;\n');
    commitAll('one');
    const blocked = hook('pre', { tool_name: 'mcp__github__create_pull_request', tool_input: { draft: true } });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('record advisor');
    expect(runScript(STATE, 'record', 'advisor').status).toBe(0);
    expect(hook('pre', { tool_name: 'mcp__github__create_pull_request', tool_input: { draft: true } }).status).toBe(0);
  });
});

describe.skipIf(isWindows)('workflow-guard pre: acceptance before leaving draft', () => {
  it('allows creating a draft PR without an acceptance check', () => {
    expect(hook('pre', { tool_name: 'mcp__github__create_pull_request', tool_input: { draft: true } }).status).toBe(0);
  });

  it('blocks a non-draft PR, or marking one ready, until acceptance is recorded for HEAD', () => {
    const create = hook('pre', { tool_name: 'mcp__github__create_pull_request', tool_input: {} });
    expect(create.status).toBe(2);
    expect(create.stderr).toContain('acceptance-checker');
    expect(hook('pre', { tool_name: 'mcp__github__update_pull_request', tool_input: { draft: false } }).status).toBe(2);

    expect(runScript(STATE, 'record', 'acceptance').status).toBe(0);
    expect(hook('pre', { tool_name: 'mcp__github__create_pull_request', tool_input: {} }).status).toBe(0);
    expect(hook('pre', { tool_name: 'mcp__github__update_pull_request', tool_input: { draft: false } }).status).toBe(0);
  });

  it('needs a new acceptance check after another commit', () => {
    runScript(STATE, 'record', 'acceptance');
    write('src/feature.ts', 'export const a = 2;\n');
    commitAll('more');
    expect(hook('pre', { tool_name: 'mcp__github__update_pull_request', tool_input: { draft: false } }).status).toBe(2);
  });

  it('leaves other PR updates alone', () => {
    expect(hook('pre', { tool_name: 'mcp__github__update_pull_request', tool_input: { body: 'x' } }).status).toBe(0);
    expect(hook('pre', { tool_name: 'mcp__github__update_pull_request', tool_input: { draft: true } }).status).toBe(0);
  });
});

describe.skipIf(isWindows)('workflow-guard pre: review threads', () => {
  it('blocks resolving a review thread, which the reviewer closes', () => {
    const result = hook('pre', { tool_name: 'mcp__github__resolve_review_thread', tool_input: { threadId: 'PRRT_x' } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('closed by the reviewer');
  });

  it('leaves replying on a thread alone', () => {
    expect(hook('pre', { tool_name: 'mcp__github__add_reply_to_pull_request_comment', tool_input: { body: 'Fixed in abc' } }).status).toBe(0);
  });
});

describe.skipIf(isWindows)('workflow-guard notify', () => {
  const event = (kind: string) => `<event source="github" kind="${kind}" from="system">{}</event>`;

  it('reminds the session to dispatch pr-triage for PR activity', () => {
    const result = hook('notify', { tool_name: 'ReadNotifications', tool_response: `${event('check_run.completed')}\n${event('issue_comment.created')}` });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(output.hookSpecificOutput.additionalContext).toContain('check_run.completed, issue_comment.created');
    expect(output.hookSpecificOutput.additionalContext).toContain('pr-triage');
  });

  it('still reminds when a merge notice arrives alongside other PR activity, naming only that activity', () => {
    const result = hook('notify', { tool_name: 'ReadNotifications', tool_response: `${event('pull_request.closed')}\n${event('check_run.completed')}` });
    expect(result.stdout).toContain('(check_run.completed)');
  });

  it('finds events in a structured (JSON-escaped) tool response', () => {
    const result = hook('notify', { tool_name: 'ReadNotifications', tool_response: { text: event('pull_request_review.submitted') } });
    expect(result.stdout).toContain('pull_request_review.submitted');
  });

  it('says nothing for a subscription notice or a merged/closed PR alone, or for another tool', () => {
    expect(hook('notify', { tool_name: 'ReadNotifications', tool_response: event('subscription.created') }).stdout).toBe('');
    expect(hook('notify', { tool_name: 'ReadNotifications', tool_response: event('pull_request.closed') }).stdout).toBe('');
    expect(hook('notify', { tool_name: 'Bash', tool_response: event('check_run.completed') }).stdout).toBe('');
  });
});

describe.skipIf(isWindows)('precommit.mjs', () => {
  it('records nothing when files change while the checks run', () => {
    write('package.json', JSON.stringify({
      name: 'fixture',
      scripts: { typecheck: 'node -e "0"', test: 'node -e "require(\'fs\').writeFileSync(\'during.txt\', \'x\')"' },
    }));
    const result = runScript(PRECOMMIT);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Files changed while the checks ran');
    expect(runScript(STATE, 'status').stdout).toContain('precommit:  none');
  });

  it('runs only the changed tests, and lints changed scripts, when no shared infrastructure changed', () => {
    commitAll('fixture scripts'); // package.json now matches HEAD, though still differs from main
    git('push', '-q', 'origin', 'HEAD:main'); // so main has it and the branch's diff is only what follows
    write('src/feature.ts', 'export const a = 2;\n');
    const result = runPrecommitWithFakeNpx(0);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('precommit passed (changed tests; 0 skill self-test(s); eslint on 1 file(s))');
    expect(result.calls).toEqual(['vitest run --changed origin/main', 'eslint src/feature.ts']);
  });

  it.each([['src/shared/x.ts'], ['src/test-utils/x.ts'], ['migrations/100_x.sql'], ['tsconfig.build.json'], ['.claude/hooks/x.mjs'], ['.claude/skills/precommit/x.md']])(
    'runs the full suite when %s changes',
    (file) => {
      commitAll('fixture scripts');
      git('push', '-q', 'origin', 'HEAD:main');
      write(file, '// x\n');
      const result = runPrecommitWithFakeNpx(0);
      expect(result.stdout).toContain('precommit passed (full suite');
      expect(result.calls.some((c) => c.startsWith('vitest'))).toBe(false);
    },
  );

  it('runs the self-test of a skill whose folder changed, and fails when it fails', () => {
    write('.claude/skills/demo/selftest.mjs', "import { it } from 'node:test';\nit('passes', () => {});\n");
    commitAll('fixture scripts');
    git('push', '-q', 'origin', 'HEAD:main');
    write('.claude/skills/demo/SKILL.md', 'changed\n');
    const passing = runPrecommitWithFakeNpx(0);
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain('skill self-tests: node --test .claude/skills/demo/selftest.mjs');
    expect(passing.stdout).toContain('precommit passed (changed tests; 1 skill self-test(s); eslint on 0 file(s))');

    write('.claude/skills/demo/selftest.mjs', "import { it } from 'node:test';\nit('fails', () => { throw new Error('no'); });\n");
    const failing = runPrecommitWithFakeNpx(0);
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain('precommit failed (changed tests): skill self-tests');
  });

  it('skips a self-test that loads Playwright, with a note, when Playwright can\'t be resolved', () => {
    write('.claude/skills/browser/selftest.mjs', "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('playwright');\n");
    write('.claude/skills/plain/selftest.mjs', "import { it } from 'node:test';\nit('passes', () => {});\n");
    commitAll('fixture scripts');
    git('push', '-q', 'origin', 'HEAD:main');
    write('.claude/skills/browser/SKILL.md', 'changed\n');
    write('.claude/skills/plain/SKILL.md', 'changed\n');
    // Run copies of precommit.mjs and the helper it imports from a folder outside any node_modules,
    // with no NODE_PATH or HOME global folders, so Playwright can't resolve however this machine has it.
    const tooling = path.join(path.dirname(repo), 'tooling');
    const copy = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(tooling, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(tooling, rel));
    };
    copy('.claude/skills/precommit/precommit.mjs');
    copy('.claude/hooks/workflow-state.mjs');
    const isolated = { NODE_PATH: '', HOME: tooling, USERPROFILE: tooling };
    const result = runPrecommitWithFakeNpxIn(isolated, path.join(tooling, '.claude/skills/precommit/precommit.mjs'), 0);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Skipping .claude/skills/browser/selftest.mjs: it needs the pre-installed Playwright');
    expect(result.stdout).toContain('skill self-tests: node --test .claude/skills/plain/selftest.mjs');
    expect(result.stdout).toContain('1 skill self-test(s)');
  });

  it('runs no self-test for a skill folder without one', () => {
    commitAll('fixture scripts');
    git('push', '-q', 'origin', 'HEAD:main');
    write('.claude/skills/other/SKILL.md', 'new\n');
    const result = runPrecommitWithFakeNpx(0);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('skill self-tests:');
  });

  it('runs the full suite with --full even when nothing shared changed', () => {
    commitAll('fixture scripts');
    git('push', '-q', 'origin', 'HEAD:main');
    write('notes.md', 'two\n');
    expect(runPrecommitWithFakeNpx(0, '--full').stdout).toContain('precommit passed (full suite');
  });

  it('fails and records nothing when ESLint fails', () => {
    commitAll('fixture scripts');
    git('push', '-q', 'origin', 'HEAD:main');
    write('src/feature.ts', 'export const a = 2;\n');
    const result = runPrecommitWithFakeNpx(1);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('precommit failed (changed tests): tests (changed), eslint');
  });

  it('records nothing and exits 1 when a check fails', () => {
    fakeScripts(0, 1);
    const result = runScript(PRECOMMIT);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('precommit failed (full suite): tests (full)');
    expect(runScript(STATE, 'status').stdout).toContain('precommit:  none');
  });

  it('runs the full suite when shared infrastructure (package.json) changed, and records the tree', () => {
    const result = runScript(PRECOMMIT);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('precommit passed (full suite');
    expect(runScript(STATE, 'status').stdout).toContain('precommit:  current');
  });

  it('reports every failing check, not just the first', () => {
    fakeScripts(1, 1);
    expect(runScript(PRECOMMIT).stdout).toContain('typecheck, tests (full)');
  });
});

describe('.claude/settings.json hook wiring', () => {
  type HookEntry = { matcher: string; hooks: { command: string }[] };
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8')) as { hooks: Record<string, HookEntry[]> };
  /** The guard entry for one hook event, found by the script its command runs. */
  const guardEntry = (event: string) => settings.hooks[event]?.find((h) => h.hooks.some((c) => c.command.includes('workflow-guard.mjs')));

  it('routes Bash and the PR tools to the guard\'s pre mode, and nothing else', () => {
    const entry = guardEntry('PreToolUse');
    const matcher = new RegExp(`^(?:${entry?.matcher ?? '(?!)'})$`);
    for (const tool of ['Bash', 'mcp__github__create_pull_request', 'mcp__github__update_pull_request', 'mcp__github__resolve_review_thread']) {
      expect(matcher.test(tool)).toBe(true);
    }
    for (const tool of ['Edit', 'Write', 'mcp__github__add_reply_to_pull_request_comment', 'ReadNotifications']) {
      expect(matcher.test(tool)).toBe(false);
    }
    expect(entry?.hooks[0]?.command).toMatch(/workflow-guard\.mjs" pre$/);
  });

  it('routes ReadNotifications to the guard\'s notify mode', () => {
    const entry = guardEntry('PostToolUse');
    expect(entry?.matcher).toBe('ReadNotifications');
    expect(entry?.hooks[0]?.command).toMatch(/workflow-guard\.mjs" notify$/);
  });
});

describe.skipIf(isWindows)('workflow-state.mjs', () => {
  it('reports what each marker covers', () => {
    expect(runScript(STATE, 'status').stdout).toBe('precommit:  none\nadvisor:    not needed\nacceptance: none\n');
  });

  it('records nothing for advisor when no sensitive file changed', () => {
    expect(runScript(STATE, 'record', 'advisor').stdout).toContain('nothing to record');
  });

  it('rejects an unknown marker or command', () => {
    expect(runScript(STATE, 'record', 'precommit').status).toBe(1);
    expect(runScript(STATE, 'bogus').status).toBe(1);
  });
});
