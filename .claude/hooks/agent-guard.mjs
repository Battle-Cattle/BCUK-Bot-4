// agent-guard: PreToolUse hook for the subagents in .claude/agents/. It turns the scope rules
// their prompts state into checks the harness enforces, so a subagent that drifts is stopped
// before the main session has to catch it in diff review. It guards against accidents, not a
// determined bypass: diff review of every subagent's changes stays the real gate.
//
//   node .claude/hooks/agent-guard.mjs <mode>     (hook input JSON on stdin)
//
// Modes:
//   tests-only  Edit/Write may only touch *.test.ts files (coverage-filler).
//   lint-fix    Edit/Write may not touch config, CI, migrations, .claude/ or token crypto, and
//               may not silence a finding with eslint-disable or @ts-ignore (lint-docs-fixer).
//   bash        Bash may not change git state, install packages, call gh, edit files in place
//               or redirect output into the project (every subagent).
//
// Exit 2 blocks the tool call; Claude Code shows the subagent the stderr message.

import { readFileSync } from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Paths lint-docs-fixer must leave to the main session (CLAUDE.md "Delegation").
const LINT_FIX_PROTECTED = [
  /^migrations\//, /^\.github\//, /^\.claude\//, /^package(-lock)?\.json$/, /^tsconfig[^/]*$/,
  /^eslint\.config\.js$/, /^vitest[^/]*$/, /^knip\.json$/, /^src\/shared\/crypto\.ts$/,
];

const SILENCERS = /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck/;

const BASH_RULES = [
  [/\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push|checkout|switch|reset|stash|restore|rebase|merge|cherry-pick|revert|clean|add|rm|mv|apply|am|tag|worktree)\b/, 'changes git state'],
  [/\bgit\s+(?:-C\s+\S+\s+)?branch\s+-[dDmMfc]/, 'changes git state'],
  [/\bgh\s/, 'calls GitHub through gh'],
  [/\bnpm\s+(?:install|i|ci|uninstall|update|add)\b/, 'changes node_modules'],
  [/\bsed\s+(?:-\S+\s+)*-[a-zA-Z]*i/, 'edits a file in place'],
  [/(?:^|[\s;&|(])(?:rm|mv|tee)\s/, 'deletes, moves or writes files'],
  [/--fix\b/, 'rewrites files with --fix'],
];

/**
 * Reads the hook input Claude Code sends on stdin.
 * @returns the parsed hook input: tool_name and tool_input of the call being checked
 */
function readHookInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Blocks the tool call with a message the subagent sees.
 * @param reason why the call is out of the subagent's scope and what to do instead
 */
function block(reason) {
  process.stderr.write(`Blocked by .claude/hooks/agent-guard.mjs: ${reason}\n`);
  process.exit(2);
}

/**
 * Turns a tool's file path into a path relative to the project root.
 * @param filePath absolute or relative path from the Edit/Write tool input
 * @returns the path relative to the project root with forward slashes, or null when it is outside the project
 */
function projectRelative(filePath) {
  const rel = path.relative(PROJECT_DIR, path.resolve(PROJECT_DIR, filePath)).split(path.sep).join('/');
  return rel.startsWith('../') || rel === '..' || path.isAbsolute(rel) ? null : rel;
}

/**
 * Collects the text an Edit or Write call would add to a file.
 * @param input the tool_input of the Edit or Write call
 * @returns the new content, joined when the call carries several edits
 */
function addedText(input) {
  const edits = Array.isArray(input.edits) ? input.edits.map((e) => e.new_string ?? '') : [];
  return [input.content, input.new_string, ...edits].filter((s) => typeof s === 'string').join('\n');
}

/**
 * Checks an Edit/Write call against the tests-only or lint-fix scope.
 * @param mode the guard mode named on the command line
 * @param input the tool_input of the call
 */
function checkFileEdit(mode, input) {
  const rel = projectRelative(String(input.file_path ?? input.notebook_path ?? ''));
  if (rel === null) block('the file is outside the project.');
  if (mode === 'tests-only' && !rel.endsWith('.test.ts')) {
    block(`${rel} is not a *.test.ts file. If the lines can't be covered without changing source, stop and report why.`);
  }
  if (mode === 'lint-fix') {
    if (LINT_FIX_PROTECTED.some((re) => re.test(rel))) block(`${rel} is config, CI, a migration or token crypto: leave it to the main session.`);
    if (SILENCERS.test(addedText(input))) block('silencing a finding (eslint-disable, @ts-ignore) is not a fix. Report it to the caller instead.');
  }
}

/**
 * Removes quoted strings so a pattern inside quotes (grep "git push") isn't read as a command.
 * @param command the Bash command line
 * @returns the command with the contents of '…' and "…" removed
 */
function stripQuotes(command) {
  return command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Checks a Bash command for anything that changes the repository, its packages or GitHub.
 * @param command the Bash command line
 */
function checkBash(command) {
  const bare = stripQuotes(command);
  for (const [re, what] of BASH_RULES) {
    if (re.test(bare)) block(`this command ${what}. Subagents leave that to the main session; edit files with the Edit tool.`);
  }
  for (const match of bare.matchAll(/\d*>>?\s*([^\s;&|)]+)/g)) {
    const target = match[1] ?? '';
    if (!/^(?:&|\/dev\/null$|\/tmp\/)/.test(target)) block(`redirecting output to ${target} writes a file. Read output directly, or write to /tmp/.`);
  }
}

const mode = process.argv[2];
const { tool_name: toolName, tool_input: input = {} } = readHookInput();

if (toolName === 'Bash' && mode === 'bash') checkBash(String(input.command ?? ''));
if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName) && (mode === 'tests-only' || mode === 'lint-fix')) {
  checkFileEdit(mode, input);
}
process.exit(0);
