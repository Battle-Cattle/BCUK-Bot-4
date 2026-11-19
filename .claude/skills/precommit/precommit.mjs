// precommit: the precommit skill's checks as one command, so they run the same way every time
// and the commit hook (.claude/hooks/workflow-guard.mjs) can tell they passed.
//
//   node .claude/skills/precommit/precommit.mjs           pick the test scope from what changed
//   node .claude/skills/precommit/precommit.mjs --full    always run the full suite
//
// Runs typecheck, the tests (the full suite when shared infrastructure changed, otherwise the
// tests that import a changed file) and ESLint on every file the branch adds or changes, and
// reports every failure rather than stopping at the first. Only when all pass, and nothing changed
// while they ran, does it record the working tree it checked; the commit hook allows a commit of
// exactly that content.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, worktreeTree, writeMarker } from '../../hooks/workflow-state.mjs';

/** Changes that need the full suite (CLAUDE.md "ALWAYS: Before Committing"). */
const FULL_SUITE_PATHS = /^(src\/db\.ts|migrations\/|DATABASE-SCHEMA\.md|src\/shared\/|src\/test-utils\/|package(-lock)?\.json|tsconfig[^/]*|vitest[^/]*|eslint[^/]*)/;

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
  const full = argv.includes('--full') || needsFullSuite(changedPaths(cwd, base));
  const files = lintTargets(cwd, base);

  const failed = [
    runCheck(cwd, 'typecheck', 'npm', ['run', 'typecheck']),
    full ? runCheck(cwd, 'tests (full)', 'npm', ['test']) : runCheck(cwd, 'tests (changed)', 'npx', ['vitest', 'run', '--changed', 'origin/main']),
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
  process.stdout.write(`\n✔ precommit passed (${scope}; eslint on ${files.length} file(s)). Recorded: this exact working tree may be committed.\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2), process.cwd()));
}
