// precommit: the precommit skill's checks as one command, so they run the same way every time
// and the commit hook (.claude/hooks/workflow-guard.mjs) can tell they passed.
//
//   node .claude/skills/precommit/precommit.mjs           pick the test scope from what changed
//   node .claude/skills/precommit/precommit.mjs --full    always run the full suite
//
// Runs typecheck, the tests (the full suite when shared infrastructure changed, otherwise the
// tests that import a changed file), the self-test of each skill whose folder changed, and ESLint
// on every file the branch adds or changes, and
// reports every failure rather than stopping at the first. Only when all pass, and nothing changed
// while they ran, does it record the working tree it checked; the commit hook allows a commit of
// exactly that content.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, worktreeTree, writeMarker } from '../../hooks/workflow-state.mjs';

/**
 * Changes that need the full suite (CLAUDE.md "ALWAYS: Before Committing"). The hooks and this script
 * are tested by src/workflowGuard.test.ts, which runs them as child processes rather than importing
 * them, so `vitest --changed` can't see that it depends on them.
 */
const FULL_SUITE_PATHS = /^(src\/db\.ts|migrations\/|DATABASE-SCHEMA\.md|src\/shared\/|src\/test-utils\/|package(-lock)?\.json|tsconfig[^/]*|vitest[^/]*|eslint[^/]*|\.claude\/hooks\/|\.claude\/skills\/precommit\/)/;

const LINTED = /\.(ts|js|mjs|mts)$/;

/**
 * Splits git output into a list of paths.
 * @param output git's stdout, one path per line
 * @returns the non-empty lines
 */
function lines(output) {
  return output.split('\n').filter(Boolean);
}

/**
 * Lists every path the branch changes against main: committed, staged, unstaged and untracked.
 * @param cwd the repository folder
 * @param base the merge-base with origin/main
 * @returns the changed paths, deletions included
 */
function changedPaths(cwd, base) {
  return [...new Set([
    ...lines(git(['diff', '--name-only', base], { cwd })),
    ...lines(git(['ls-files', '--others', '--exclude-standard'], { cwd })),
  ])];
}

/**
 * Lists the files ESLint should check: what the branch adds or changes, minus deletions.
 * @param cwd the repository folder
 * @param base the merge-base with origin/main
 * @returns the script and TypeScript files to lint
 */
function lintTargets(cwd, base) {
  return [...new Set([
    ...lines(git(['diff', '--name-only', '--diff-filter=d', base], { cwd })),
    ...lines(git(['ls-files', '--others', '--exclude-standard'], { cwd })),
  ])].filter((f) => LINTED.test(f)).sort();
}

/**
 * Says whether the pre-installed Playwright can be loaded from here (it isn't a project dependency).
 * @returns true when `require('playwright')` would resolve
 */
function playwrightAvailable() {
  try {
    createRequire(import.meta.url).resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists the skill self-tests to run: `.claude/skills/<name>/selftest.mjs` for each skill folder the
 * branch changes. They sit outside Vitest's `src/**` include, so nothing else runs them. One that
 * loads Playwright (names `'playwright'` in an import or require) is skipped, with a note, where
 * Playwright isn't installed.
 * @param cwd the repository folder
 * @param paths the paths the branch changes
 * @returns the self-test paths, relative to the repository
 */
function skillSelftests(cwd, paths) {
  const skills = new Set(paths.map((p) => /^\.claude\/skills\/([^/]+)\//.exec(p)?.[1]).filter(Boolean));
  const tests = [...skills].sort().map((name) => `.claude/skills/${name}/selftest.mjs`).filter((t) => existsSync(path.join(cwd, t)));
  return tests.filter((t) => {
    const needsBrowser = /['"]playwright['"]/.test(readFileSync(path.join(cwd, t), 'utf8'));
    if (needsBrowser && !playwrightAvailable()) {
      process.stdout.write(`Skipping ${t}: it needs the pre-installed Playwright, which isn't available here.\n`);
      return false;
    }
    return true;
  });
}

/**
 * Decides whether the change needs the full suite.
 * @param paths the paths the branch changes
 * @returns true when any of them is shared infrastructure
 */
function needsFullSuite(paths) {
  return paths.some((p) => FULL_SUITE_PATHS.test(p));
}

/**
 * Runs one check with its output shown live.
 * @param cwd the repository folder
 * @param label the name to report it under
 * @param command the program to run
 * @param args its arguments
 * @returns the label when the check failed, otherwise null
 */
function runCheck(cwd, label, command, args) {
  process.stdout.write(`\n▶ ${label}: ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  return result.status === 0 ? null : label;
}

/**
 * Runs the checks and records the working tree when they all pass.
 * @param argv the arguments after the script name
 * @param cwd the repository folder
 * @returns the process exit code: 0 when everything passed
 */
function main(argv, cwd) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 24) {
    process.stderr.write(`Node ${process.versions.node}: switch to Node 24 first (CLAUDE.md "Node/npm version").\n`);
    return 1;
  }
  try {
    git(['fetch', '-q', 'origin', 'main'], { cwd });
  } catch {
    process.stderr.write('Couldn\'t fetch origin/main; comparing with the copy already here.\n');
  }
  const base = git(['merge-base', 'origin/main', 'HEAD'], { cwd });
  const before = worktreeTree(cwd);
  const paths = changedPaths(cwd, base);
  const full = argv.includes('--full') || needsFullSuite(paths);
  const files = lintTargets(cwd, base);
  const selftests = skillSelftests(cwd, paths);

  const failed = [
    runCheck(cwd, 'typecheck', 'npm', ['run', 'typecheck']),
    full ? runCheck(cwd, 'tests (full)', 'npm', ['test']) : runCheck(cwd, 'tests (changed)', 'npx', ['vitest', 'run', '--changed', 'origin/main']),
    selftests.length ? runCheck(cwd, 'skill self-tests', 'node', ['--test', ...selftests]) : null,
    files.length ? runCheck(cwd, 'eslint', 'npx', ['eslint', ...files]) : null,
  ].filter(Boolean);

  const scope = full ? 'full suite' : 'changed tests';
  if (failed.length) {
    process.stdout.write(`\n✖ precommit failed (${scope}): ${failed.join(', ')}. Nothing recorded.\n`);
    return 1;
  }
  if (worktreeTree(cwd) !== before) {
    process.stdout.write('\n✖ Files changed while the checks ran, so they may not have covered them. Run precommit again.\n');
    return 1;
  }
  writeMarker(cwd, 'precommit', { tree: before, scope });
  process.stdout.write(`\n✔ precommit passed (${scope}; ${selftests.length} skill self-test(s); eslint on ${files.length} file(s)). Recorded: this exact working tree may be committed.\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2), process.cwd()));
}
