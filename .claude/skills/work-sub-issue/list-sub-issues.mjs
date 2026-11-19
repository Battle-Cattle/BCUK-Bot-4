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
 * Pulls what a body says it depends on: from the `## Depends on` section (up to the next heading) and
 * any inline "Depends on …" / "Blocked by …", both issue references (`#1071`) and sibling part
 * references (`2/9`, as #917's parts write them). A section that opens with "None" or "Nothing" has
 * no dependencies: what follows is a note ("Nothing. Can be done in parallel with 2/6.").
 * @param body - The issue body (markdown).
 * @returns `{ issues, parts }`: issue numbers and part numbers, each ascending without duplicates.
 */
export function parseDependsOn(body) {
  const text = body ?? '';
  const issues = new Set();
  const parts = new Set();
  const section = /^#{1,6}\s*Depends on\s*$([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im.exec(text);
  const inline = text.match(/(?:depends on|blocked by)[^\n.]*/gi) ?? [];
  const sectionText = section?.[1].trim() ?? '';
  const none = /^(?:none|nothing)\b/i.test(sectionText);
  for (const chunk of [none ? '' : sectionText, ...inline]) {
    for (const [, n] of chunk.matchAll(/#(\d+)/g)) issues.add(Number(n));
    for (const [, n] of chunk.matchAll(/(?<![#\d])\b(\d+)\/\d+\b/g)) parts.add(Number(n));
  }
  const sorted = (set) => [...set].sort((a, b) => a - b);
  return { issues: sorted(issues), parts: sorted(parts) };
}

/**
 * Pulls the issue numbers a PR body closes: "Closes #N", "Fixes #N", "Resolves #N" in any tense,
 * including a comma-separated list after one keyword ("Closes #1, #2 and #3").
 * @param body - The PR body (markdown).
 * @returns The closed issue numbers.
 */
export function parseClosingRefs(body) {
  const clauses = (body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(#\d+(?:(?:\s*,\s*|\s+and\s+)#\d+)*)/gi);
  return [...clauses].flatMap((m) => [...m[1].matchAll(/#(\d+)/g)].map((r) => Number(r[1])));
}

/**
 * Looks up, for each closed sub-issue, the merged PR whose body closes it, and failing that a merged
 * PR that only mentions it (a part closed by hand after a PR that covered several parts). Searches
 * in batches.
 * @param repo - `owner/name` of the repository.
 * @param numbers - The closed sub-issue numbers.
 * @returns `{ closedBy, mentionedBy }`: issue number to PR number for each kind of match.
 */
function findClosingPrs(repo, numbers) {
  const closedBy = new Map();
  const mentionedBy = new Map();
  for (let i = 0; i < numbers.length; i += PR_QUERY_BATCH) {
    const batch = numbers.slice(i, i + PR_QUERY_BATCH);
    const terms = batch.map((n) => `"#${n}"`).join(' OR ');
    for (const pr of ghSearch('search/issues', `repo:${repo} is:pr is:merged in:body ${terms}`)) {
      const closes = parseClosingRefs(pr.body);
      for (const n of batch) {
        const mentioned = new RegExp(`#${n}\\b`).test(pr.body ?? '');
        if (closes.includes(n) && !closedBy.has(n)) closedBy.set(n, pr.number);
        else if (mentioned && !mentionedBy.has(n)) mentionedBy.set(n, pr.number);
      }
    }
  }
  return { closedBy, mentionedBy };
}

/**
 * The "n" of an "n/N" part number in a title.
 * @param issue - A sub-issue.
 * @returns The part number, or null when the title has none.
 */
function partOf(issue) {
  const part = /\b(\d+)\/\d+\b/.exec(issue.title);
  return part ? Number(part[1]) : null;
}

/**
 * Builds what formatLine needs to know about the sub-issues around one.
 * @param issues - Every sub-issue listed.
 * @param prs - `{ closedBy, mentionedBy }` from findClosingPrs (empty maps when not looked up).
 * @returns `{ states, parts, closedBy, mentionedBy }`: issue number to state, part number to issue number, and the PR maps.
 */
export function buildContext(issues, prs = { closedBy: new Map(), mentionedBy: new Map() }) {
  const parts = new Map(issues.filter((i) => partOf(i) !== null).map((i) => [partOf(i), i.number]));
  return { states: new Map(issues.map((i) => [i.number, i.state])), parts, ...prs };
}

/**
 * The status after the dependencies for a closed sub-issue.
 * @param issue - The closed sub-issue (`number`, `state_reason`?).
 * @param ctx - From buildContext.
 * @returns E.g. `closed by PR #1100`, `closed as not planned`.
 */
function closedStatus(issue, ctx) {
  if (issue.state_reason === 'not_planned') return 'closed as not planned';
  if (ctx.closedBy.has(issue.number)) return `closed by PR #${ctx.closedBy.get(issue.number)}`;
  if (ctx.mentionedBy.has(issue.number)) return `closed by hand; merged PR #${ctx.mentionedBy.get(issue.number)} mentions it`;
  return 'closing PR not found';
}

/**
 * The status after the dependencies for an open sub-issue.
 * @param issue - The open sub-issue (`issue_dependencies_summary`?).
 * @param deps - Its dependencies as issue numbers.
 * @param ctx - From buildContext.
 * @returns `ready`, `waiting on a dependency` or a GitHub dependency-link note.
 */
function openStatus(issue, deps, ctx) {
  if (deps.some((n) => ctx.states.get(n) !== 'closed')) return 'waiting on a dependency';
  const nativeBlocks = issue.issue_dependencies_summary?.blocked_by ?? 0;
  return nativeBlocks > 0 ? `blocked by ${nativeBlocks} open GitHub dependency link(s)` : 'ready';
}

/**
 * Formats one sub-issue as a single line, resolving part-number dependencies to sibling issues.
 * @param issue - The sub-issue (`number`, `state`, `state_reason`?, `title`, `body`, `issue_dependencies_summary`?).
 * @param ctx - From buildContext.
 * @returns The line, e.g. `#1074 open   Dashboard refresh 4/13: … | deps: none | ready`.
 */
export function formatLine(issue, ctx) {
  const { issues, parts } = parseDependsOn(issue.body);
  const unresolved = parts.filter((p) => !ctx.parts.has(p)).map((p) => `part ${p} ?`);
  const deps = [...new Set([...issues, ...parts.filter((p) => ctx.parts.has(p)).map((p) => ctx.parts.get(p))])].sort((a, b) => a - b);
  const listed = [...deps.map((n) => `#${n} ${ctx.states.get(n) ?? '?'}`), ...unresolved];
  const status = issue.state === 'closed' ? closedStatus(issue, ctx) : openStatus(issue, deps, ctx);
  return `#${issue.number} ${issue.state.padEnd(6)} ${issue.title} | deps: ${listed.length ? listed.join(', ') : 'none'} | ${status}`;
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
  const closed = issues.filter((i) => i.state === 'closed').map((i) => i.number);
  let prs;
  try {
    prs = findClosingPrs(repo, closed);
  } catch (err) {
    console.error(`closing PRs not looked up (gh search failed: ${err.message.split('\n')[0]})`);
  }
  const ctx = buildContext(issues, prs);
  const order = (i) => partOf(i) ?? i.number;
  for (const issue of [...issues].sort((a, b) => order(a) - order(b))) console.log(formatLine(issue, ctx));
  console.log(`${issues.length} sub-issue(s) of #${parent}, ${closed.length} closed${fromFile ? '' : ' (found by search: compare with the parent\'s sub_issues_summary.total)'}`);
}

// Run only from the command line, so selftest.mjs can import the parsers.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
