// workflow-guard: hooks for the main session that turn CLAUDE.md's "before you commit / push /
// leave draft" rules into checks the harness runs on every matching tool call, so a step can't
// be skipped by misjudging whether it applies. The markers it checks are kept by
// workflow-state.mjs; see that file for how each one is recorded.
//
//   node .claude/hooks/workflow-guard.mjs pre      PreToolUse: Bash, create_pull_request, update_pull_request
//   node .claude/hooks/workflow-guard.mjs notify   PostToolUse: ReadNotifications
//
// pre blocks (exit 2, the reason on stderr):
//   git commit                     unless precommit.mjs passed on exactly the current working tree
//   git push, create_pull_request  unless the advisor was consulted about the branch's current diff
//                                  to a migration, startup, auth middleware or token crypto file
//   leaving draft                  unless acceptance-checker ran on the current HEAD (create_pull_request
//                                  without draft: true, or update_pull_request with draft: false)
//   resolving a review thread      always: the reviewer (CodeRabbit, Qlty or a person) closes its own thread
// notify adds a reminder to dispatch pr-triage when PR activity arrives; it never blocks.
//
// A git or filesystem error lets the call through: the guard must never wedge a session over a
// broken check. The person running the session can turn it off with CLAUDE_WORKFLOW_GUARD=off in
// Claude Code's own environment (a Bash command can't set it for the hook).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { advisorScope, git, readMarker, worktreeTree } from './workflow-state.mjs';

const PRECOMMIT = 'node .claude/skills/precommit/precommit.mjs';
const RECORD = 'node .claude/hooks/workflow-state.mjs record';

/**
 * Reads the hook input Claude Code sends on stdin.
 * @returns the parsed hook input: tool_name, tool_input, tool_response and cwd of the call
 */
function readHookInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Blocks the tool call with a message the session sees.
 * @param reason what is missing and how to do it
 */
function block(reason) {
  process.stderr.write(`Blocked by .claude/hooks/workflow-guard.mjs: ${reason}\n`);
  process.exit(2);
}

/**
 * Removes heredoc bodies and quoted strings, so text written to a file or passed as a commit
 * message or grep pattern ("git push") isn't read as a command.
 * @param command the Bash command line
 * @returns the command without heredoc bodies and with the contents of '…' and "…" removed
 */
function stripQuotes(command) {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, '<<heredoc')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Commands that may come before a commit or push on the same command line: they change neither
 * the files nor the commits the hook checks (`git add` only stages what is already there).
 */
const SAFE_BEFORE = /^\s*(?:cd\s+\S+|git(?:\s+-[Cc]\s+\S+)*\s+(?:add|status|diff|log|fetch|show|rev-parse)\b[^\n]*)?\s*$/;

/**
 * Finds a git subcommand in a Bash command line, with the folder it runs in.
 * @param command the Bash command line
 * @param subcommand commit or push
 * @param cwd the folder the command starts in
 * @returns where the subcommand runs, and whether anything before it on the line could change
 *   the files or commits (the hook sees the state before the whole line runs); null when the
 *   command doesn't run it
 */
function findGitCommand(command, subcommand, cwd) {
  const bare = stripQuotes(command);
  const re = new RegExp(String.raw`(?:^|[\s;&|(])git((?:\s+-[Cc]\s+\S+)*)\s+${subcommand}(?![\w-])`);
  const match = re.exec(bare);
  if (!match) return null;
  const before = bare.slice(0, match.index + match[0].indexOf('git'));
  // A `cd` earlier in the same command line moves where git runs.
  const cds = [...before.matchAll(/(?:^|[\s;&|(])cd\s+([^\s;&|)]+)/g)];
  const start = cds.reduce((dir, cd) => path.resolve(dir, cd[1] ?? '.'), cwd);
  const dir = /-C\s+(\S+)/.exec(match[1] ?? '');
  const unsafeBefore = before.split(/&&|\|\||[;|\n(]/).some((part) => !SAFE_BEFORE.test(part));
  return { dir: dir?.[1] ? path.resolve(start, dir[1]) : start, unsafeBefore };
}

/**
 * Blocks a commit or push that shares its command line with something that could change what
 * it acts on, since the hook can only check the state from before the line runs.
 * @param found what findGitCommand returned
 * @param subcommand commit or push
 */
function requireOwnCommand(found, subcommand) {
  if (!found.unsafeBefore) return;
  block(
    `run \`git ${subcommand}\` in its own Bash call (only cd and git add/status/diff/log/fetch may come before it), ` +
    'so this hook checks the files and commits it will actually act on.',
  );
}

/**
 * Requires a precommit run that covered exactly what would be committed.
 * @param dir the repository folder
 */
function requirePrecommit(dir) {
  const tree = worktreeTree(dir); // first, so a broken repository throws rather than reading as "no marker"
  const marker = readMarker(dir, 'precommit');
  if (!marker) block(`no precommit run is recorded. Run \`${PRECOMMIT}\` (the precommit skill) and commit once it passes.`);
  if (marker.tree !== tree) {
    block(`files changed since precommit last passed (${marker.at}). Run \`${PRECOMMIT}\` again and commit once it passes.`);
  }
}

/**
 * Requires an advisor consult covering the branch's current diff to advisor-sensitive files.
 * @param dir the repository folder
 */
function requireAdvisor(dir) {
  const { files, key } = advisorScope(dir);
  if (!key || readMarker(dir, 'advisor')?.key === key) return;
  block(
    `this branch changes ${files.join(', ')}, which CLAUDE.md says to take to the advisor subagent before pushing ` +
    `(a migration, startup, auth middleware or token crypto). Consult it about the change, act on what it raises, then run \`${RECORD} advisor\`. ` +
    'A later change to these files needs a new consult.',
  );
}

/**
 * Requires an acceptance check on the current HEAD before a PR leaves draft.
 * @param dir the repository folder
 */
function requireAcceptance(dir) {
  const head = git(['rev-parse', 'HEAD'], { cwd: dir });
  if (readMarker(dir, 'acceptance')?.head === head) return;
  block(
    'a PR leaves draft only after the acceptance-checker subagent has checked the current commit against the issue it closes ' +
    `(or, with no issue, the PR's stated scope). Run it, fix or report anything missing, then run \`${RECORD} acceptance\`.`,
  );
}

/**
 * Applies the PreToolUse rules to one tool call.
 * @param toolName the tool being called
 * @param input the tool_input of the call
 * @param cwd the session's working folder
 */
function checkPre(toolName, input, cwd) {
  if (toolName === 'Bash') {
    const command = String(input.command ?? '');
    for (const [subcommand, require] of [['commit', requirePrecommit], ['push', requireAdvisor]]) {
      const found = findGitCommand(command, subcommand, cwd);
      if (!found) continue;
      requireOwnCommand(found, subcommand);
      require(found.dir);
    }
    return;
  }
  if (toolName === 'mcp__github__create_pull_request') {
    requireAdvisor(cwd);
    if (input.draft !== true) requireAcceptance(cwd);
    return;
  }
  if (toolName === 'mcp__github__update_pull_request' && input.draft === false) requireAcceptance(cwd);
  if (toolName === 'mcp__github__resolve_review_thread') {
    block(
      'review threads are closed by the reviewer who opened them, not by this session: reply on the thread with the fixing commit ' +
      'and let CodeRabbit (or the person) confirm and resolve it. A thread it reopens or disputes stays open until it agrees.',
    );
  }
}

/**
 * Builds the reminder for PR activity in a ReadNotifications result.
 * @param response the tool_response of the ReadNotifications call
 * @returns the reminder, or null when the result holds no PR activity to act on
 */
function triageReminder(response) {
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  const kinds = [...text.matchAll(/source=\\?"github\\?"\s+kind=\\?"([\w.]+)\\?"/g)]
    .map((m) => m[1])
    .filter((kind) => kind !== 'subscription.created');
  if (kinds.length === 0) return null;
  return `PR activity arrived (${[...new Set(kinds)].join(', ')}). CLAUDE.md "Delegation": dispatch the pr-triage subagent for it ` +
    'before acting, and follow the drive-pr skill for what to do with its findings.';
}

/**
 * Runs the hook: reads the call from stdin and applies the mode named on the command line.
 * @param mode pre or notify
 */
function run(mode) {
  if (process.env.CLAUDE_WORKFLOW_GUARD === 'off') return;
  const { tool_name: toolName, tool_input: input = {}, tool_response: response, cwd } = readHookInput();
  const dir = cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    if (mode === 'pre') checkPre(toolName, input, dir);
    if (mode === 'notify' && toolName === 'ReadNotifications') {
      const reminder = triageReminder(response);
      if (reminder) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reminder } }));
    }
  } catch (err) {
    process.stderr.write(`workflow-guard skipped its check: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv[2]);
  process.exit(0);
}
