// list-sub-issues: one line per sub-issue of a parent issue (number, state, title, dependencies and
// whether they're closed, and the merged PR that closed it), so picking the next part doesn't need
// every sub-issue body in context. See step 1 of SKILL.md next to this file.
//
//   node .claude/skills/work-sub-issue/list-sub-issues.mjs <parent> [--from-file <saved.json>] [--repo owner/name]
//
// By default it reads through `gh api search/issues`, the one `gh` use cloud sessions allow: issues
// whose body mentions #<parent>, kept only when GitHub says <parent> is their parent, then merged PRs
// that mention those numbers, for the "Closes #N" link. A sub-issue whose body never mentions its
// parent isn't found that way, so the script prints how many it found: compare that with the parent's
// `sub_issues_summary.total`, and when they differ, save the GitHub MCP `get_sub_issues` result to a
// file and pass it with --from-file (bodies are parsed here, not read into the session).

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPO = 'Battle-Cattle/BCUK-Bot-4';

/** Search allows five boolean operators, so at most five numbers per OR'd PR query. */
const PR_QUERY_BATCH = 5;

/**
 * Runs one read-only `gh api` search and returns every result page's items.
 * @param endpoint - The search endpoint, e.g. `search/issues`.
 * @param query - The search query string.
 * @returns The `items` of every page.
 */
function ghSearch(endpoint, query) {
  const out = execFileSync('gh', ['api', '-X', 'GET', endpoint, '-f', `q=${query}`, '-f', 'per_page=100', '--paginate', '--jq', '.items[]'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Reads a saved GitHub MCP `get_sub_issues` result: a JSON array of issues, or that array wrapped in
 * the tool-result envelope (`[{ type: 'text', text: '[…]' }]`).
 * @param file - Path of the saved result.
 * @returns The issues.
 */
async function readSavedSubIssues(file) {
  let data = JSON.parse(await readFile(file, 'utf8'));
  if (Array.isArray(data) && data[0]?.type === 'text') data = JSON.parse(data.map((d) => d.text).join(''));
  if (!Array.isArray(data)) throw new Error(`${file}: expected a JSON array of issues`);
  return data;
}

/**
 * Finds the sub-issues of a parent through search, keeping only those GitHub links to that parent.
 * @param repo - `owner/name` of the repository.
 * @param parent - The parent issue number.
 * @returns The sub-issues found.
 */
function searchSubIssues(repo, parent) {
  const suffix = `/repos/${repo}/issues/${parent}`.toLowerCase();
  return ghSearch('search/issues', `repo:${repo} is:issue in:body "#${parent}"`)
    .filter((i) => i.parent_issue_url?.toLowerCase().endsWith(suffix));
}

/**
 * Pulls the issue numbers a body says it depends on: the `## Depends on` section (up to the next
 * heading) and any inline "Depends on #N" / "Blocked by #N".
 * @param body - The issue body (markdown).
 * @returns The dependency numbers, ascending, without duplicates.
 */
export function parseDependsOn(body) {
  const text = body ?? '';
  const found = new Set();
  const section = /^#{1,6}\s*Depends on\s*$([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im.exec(text);
  const inline = text.match(/(?:depends on|blocked by)[^\n.]*/gi) ?? [];
  for (const chunk of [section?.[1] ?? '', ...inline]) {
    for (const [, n] of chunk.matchAll(/#(\d+)/g)) found.add(Number(n));
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Pulls the issue numbers a PR body closes ("Closes #N", "Fixes #N", "Resolves #N" and their tenses).
 * @param body - The PR body (markdown).
 * @returns The closed issue numbers.
 */
export function parseClosingRefs(body) {
  return [...(body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi)].map((m) => Number(m[1]));
}

/**
 * Maps each closed sub-issue to the merged PR whose body closes it, searching in batches.
 * @param repo - `owner/name` of the repository.
 * @param numbers - The closed sub-issue numbers.
 * @returns Issue number to PR number; issues with no match are absent.
 */
function findClosingPrs(repo, numbers) {
  const closedBy = new Map();
  for (let i = 0; i < numbers.length; i += PR_QUERY_BATCH) {
    const batch = numbers.slice(i, i + PR_QUERY_BATCH);
    const terms = batch.map((n) => `"#${n}"`).join(' OR ');
    for (const pr of ghSearch('search/issues', `repo:${repo} is:pr is:merged in:body ${terms}`)) {
      for (const n of parseClosingRefs(pr.body)) if (batch.includes(n) && !closedBy.has(n)) closedBy.set(n, pr.number);
    }
  }
  return closedBy;
}

/**
 * Sort key: the "n/13" part number in a title when there is one, else the issue number.
 * @param issue - A sub-issue.
 * @returns The key to sort by.
 */
function partNumber(issue) {
  const part = /\b(\d+)\/\d+\b/.exec(issue.title);
  return part ? Number(part[1]) : issue.number;
}

/**
 * Formats one sub-issue as a single line.
 * @param issue - The sub-issue (`number`, `state`, `title`, `body`, `issue_dependencies_summary`?).
 * @param states - Issue number to `open`/`closed` for every sub-issue listed.
 * @param closedBy - Issue number to the PR that closed it.
 * @returns The line, e.g. `#1074 open   Dashboard refresh 4/13: … | deps: none | ready`.
 */
export function formatLine(issue, states, closedBy) {
  const deps = parseDependsOn(issue.body);
  const depText = deps.length === 0 ? 'none' : deps.map((n) => `#${n} ${states.get(n) ?? '?'}`).join(', ');
  const nativeBlocks = issue.issue_dependencies_summary?.blocked_by ?? 0;
  let tail;
  if (issue.state === 'closed') tail = closedBy.has(issue.number) ? `closed by PR #${closedBy.get(issue.number)}` : 'closing PR not found';
  else if (deps.some((n) => states.get(n) !== 'closed')) tail = 'waiting on a dependency';
  else tail = nativeBlocks > 0 ? `blocked by ${nativeBlocks} open GitHub dependency link(s)` : 'ready';
  return `#${issue.number} ${issue.state.padEnd(6)} ${issue.title} | deps: ${depText} | ${tail}`;
}

/**
 * Reads the command line.
 * @param argv - The arguments after the script path.
 * @returns `{ parent, repo, fromFile }`.
 */
function parseArgs(argv) {
  const opts = { parent: null, repo: DEFAULT_REPO, fromFile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') opts.repo = argv[++i];
    else if (argv[i] === '--from-file') opts.fromFile = argv[++i];
    else opts.parent = Number(argv[i].replace(/^#/, ''));
  }
  if (!Number.isInteger(opts.parent) || opts.parent <= 0) {
    throw new Error('usage: node .claude/skills/work-sub-issue/list-sub-issues.mjs <parent> [--from-file <saved.json>] [--repo owner/name]');
  }
  return opts;
}

/**
 * Entry point: lists the parent's sub-issues, one line each, with a count to check against the parent.
 * @returns Resolves once printed.
 */
async function main() {
  const { parent, repo, fromFile } = parseArgs(process.argv.slice(2));
  const issues = fromFile ? await readSavedSubIssues(fromFile) : searchSubIssues(repo, parent);
  const states = new Map(issues.map((i) => [i.number, i.state]));
  const closed = issues.filter((i) => i.state === 'closed').map((i) => i.number);
  let closedBy = new Map();
  try {
    closedBy = findClosingPrs(repo, closed);
  } catch (err) {
    console.error(`closing PRs not looked up (gh search failed: ${err.message.split('\n')[0]})`);
  }
  for (const issue of [...issues].sort((a, b) => partNumber(a) - partNumber(b))) console.log(formatLine(issue, states, closedBy));
  console.log(`${issues.length} sub-issue(s) of #${parent}, ${closed.length} closed${fromFile ? '' : ' (found by search: compare with the parent\'s sub_issues_summary.total)'}`);
}

// Run only from the command line, so selftest.mjs can import the parsers.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
