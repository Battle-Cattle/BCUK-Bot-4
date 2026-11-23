// workflow-state: the records behind .claude/hooks/workflow-guard.mjs. A step the main session
// must take before committing, pushing or marking a PR ready (precommit checks, an advisor
// consult, an acceptance check) leaves a marker under the git directory, keyed to the exact
// content it covered. The guard blocks the action when the marker is missing or no longer
// matches, so a step done once doesn't cover later changes.
//
//   node .claude/hooks/workflow-state.mjs record advisor      after consulting the advisor subagent
//   node .claude/hooks/workflow-state.mjs record acceptance   after acceptance-checker reports no gaps
//   node .claude/hooks/workflow-state.mjs status              what each marker covers and whether it is current
//
// The precommit and verified (full run, required to push) markers are written only by .claude/skills/precommit/precommit.mjs, after its checks
// pass. Markers live in <git dir>/claude-workflow/, so they are never committed. Like
// agent-guard.mjs, this guards against a step being forgotten, not against a deliberate bypass.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Changes that need an advisor consult before they are pushed (CLAUDE.md "Delegation": a
 * migration, the auth middleware or its order, token crypto, the startup sequence).
 */
export const ADVISOR_PATHS = [
  /^migrations\//,
  /^src\/index\.ts$/,
  /^src\/web\/middleware\.ts$/,
  /^src\/web\/server\.ts$/,
  /^src\/shared\/crypto\.ts$/,
];

/**
 * Runs git in the project and returns its trimmed output.
 * @param args the git arguments
 * @param options extra execFileSync options (cwd, env)
 * @returns git's stdout without the trailing newline
 */
export function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

/**
 * Finds the folder the markers are kept in, inside the repository's git directory.
 * @param cwd the folder to resolve the repository from
 * @returns the absolute path of <git dir>/claude-workflow
 */
function markerDir(cwd) {
  return path.resolve(cwd, git(['rev-parse', '--git-dir'], { cwd }), 'claude-workflow');
}

/**
 * Hashes the working tree as a commit of everything would see it: tracked and untracked files,
 * minus ignored ones. Builds a throwaway index from HEAD, so the real one isn't touched, and
 * without the real index's file stat cache, which can miss a same-size edit made within the
 * filesystem's timestamp resolution; every file is hashed from its content.
 * @param cwd the repository folder
 * @returns the git tree id of the working tree's content
 */
export function worktreeTree(cwd) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'workflow-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index') };
    git(['rev-parse', '--git-dir'], { cwd }); // throws outside a repository
    try {
      git(['read-tree', 'HEAD'], { cwd, env });
    } catch {
      // no commit yet: start from an empty index
    }
    git(['add', '-A'], { cwd, env });
    return git(['write-tree'], { cwd, env });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Finds the commit this branch forked from, to measure what the branch changes.
 * @param cwd the repository folder
 * @returns the merge-base of HEAD with origin/main (or main when there is no remote branch)
 */
export function branchBase(cwd) {
  for (const ref of ['origin/main', 'main']) {
    try {
      return git(['merge-base', ref, 'HEAD'], { cwd });
    } catch {
      // try the next ref
    }
  }
  throw new Error('No origin/main or main to compare the branch with.');
}

/**
 * Describes the advisor-sensitive part of what the branch would push.
 * @param cwd the repository folder
 * @returns the sensitive files the branch changes, and a hash of their diff (null when none)
 */
export function advisorScope(cwd) {
  const base = branchBase(cwd);
  const files = git(['diff', '--name-only', base, 'HEAD'], { cwd })
    .split('\n')
    .filter((f) => f && ADVISOR_PATHS.some((re) => re.test(f)));
  if (files.length === 0) return { files, key: null };
  const diff = git(['diff', base, 'HEAD', '--', ...files], { cwd });
  return { files, key: createHash('sha256').update(diff).digest('hex') };
}

/**
 * Reads a marker.
 * @param cwd the repository folder
 * @param name the marker name: precommit, verified, advisor or acceptance
 * @returns the stored record, or null when there is none or it can't be read
 */
export function readMarker(cwd, name) {
  try {
    return JSON.parse(readFileSync(path.join(markerDir(cwd), `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Writes a marker, stamped with the time it was recorded.
 * @param cwd the repository folder
 * @param name the marker name: precommit, verified, advisor or acceptance
 * @param record what the marker covers (a tree id, diff hash or commit)
 * @returns the record as written
 */
export function writeMarker(cwd, name, record) {
  const dir = markerDir(cwd);
  mkdirSync(dir, { recursive: true });
  const stamped = { ...record, at: new Date().toISOString() };
  writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(stamped, null, 2)}\n`);
  return stamped;
}

/**
 * Records the current branch state for the advisor or acceptance step.
 * @param cwd the repository folder
 * @param name advisor or acceptance
 * @returns a line saying what was recorded
 */
function record(cwd, name) {
  if (name === 'advisor') {
    const { files, key } = advisorScope(cwd);
    if (!key) return 'This branch changes no advisor-sensitive file; nothing to record.';
    writeMarker(cwd, 'advisor', { key, files });
    return `Recorded the advisor consult for ${files.join(', ')}.`;
  }
  if (name === 'acceptance') {
    const head = git(['rev-parse', 'HEAD'], { cwd });
    writeMarker(cwd, 'acceptance', { head });
    return `Recorded the acceptance check for ${head.slice(0, 7)}.`;
  }
  throw new Error(`Unknown marker "${name}": use advisor or acceptance (precommit.mjs writes the precommit marker).`);
}

/**
 * Says what each marker covers and whether it still matches the branch.
 * @param cwd the repository folder
 * @returns one line per marker
 */
function status(cwd) {
  const precommit = readMarker(cwd, 'precommit');
  const verified = readMarker(cwd, 'verified');
  const advisor = readMarker(cwd, 'advisor');
  const acceptance = readMarker(cwd, 'acceptance');
  const scope = advisorScope(cwd);
  const head = git(['rev-parse', 'HEAD'], { cwd });
  return [
    `precommit:  ${precommit ? (precommit.tree === worktreeTree(cwd) ? 'current' : 'stale') : 'none'}`,
    `verified:   ${verified ? (verified.tree === worktreeTree(cwd) ? 'current' : 'stale') : 'none'}`,
    `advisor:    ${scope.key ? (advisor?.key === scope.key ? 'current' : 'needed') : 'not needed'}`,
    `acceptance: ${acceptance ? (acceptance.head === head ? 'current' : 'stale') : 'none'}`,
  ].join('\n');
}

/**
 * Runs the command line: record <marker> or status.
 * @param argv the arguments after the script name
 * @param cwd the repository folder
 * @returns the text to print
 */
export function main(argv, cwd) {
  const [command, name] = argv;
  if (command === 'record' && name) return record(cwd, name);
  if (command === 'status') return status(cwd);
  throw new Error('Usage: workflow-state.mjs record <advisor|acceptance> | status');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${main(process.argv.slice(2), process.cwd())}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
