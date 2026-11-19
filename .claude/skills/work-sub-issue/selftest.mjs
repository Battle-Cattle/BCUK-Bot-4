// Tests for list-sub-issues.mjs: parsing, formatting, --from-file, and the `gh` search path against a
// stub `gh` (no network). Not part of `npm test`; the precommit script runs them when this folder
// changes, or run them directly:
//
//   node --test .claude/skills/work-sub-issue/selftest.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildContext, formatLine, parseClosingRefs, parseDependsOn } from './list-sub-issues.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'list-sub-issues.mjs');

/**
 * Runs the test body with a fresh temporary folder, removed afterwards.
 * @param run - The test body, given the folder path.
 * @returns Resolves once the body and cleanup are done.
 */
async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sub-issues-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

describe('parseDependsOn', () => {
  it('reads issue references in the "## Depends on" section up to the next heading', () => {
    const body = 'Part of #998.\n\n## Depends on\n\n- #1071 (colours)\n- #1073\n\n## Acceptance\n\nSee #1080.';
    assert.deepEqual(parseDependsOn(body), { issues: [1071, 1073], parts: [] });
  });

  it('reads sibling part references, as #917\'s parts write them', () => {
    assert.deepEqual(parseDependsOn('## Depends on\n\n2/9, 4/9 (admin page), 5/9.'), { issues: [], parts: [2, 4, 5] });
  });

  it('treats a section opening with None or Nothing as no dependencies, whatever note follows', () => {
    assert.deepEqual(parseDependsOn('## Depends on\n\nNone.\n\n## Acceptance\n\n- ok'), { issues: [], parts: [] });
    assert.deepEqual(parseDependsOn('## Depends on\n\nNothing. Can be done in parallel with 2/6.'), { issues: [], parts: [] });
  });

  it('reads a section at the end of the body, and inline "Depends on" / "Blocked by", but not other references', () => {
    assert.deepEqual(parseDependsOn('Part of #998.\n\n### Depends on\n#1072').issues, [1072]);
    assert.deepEqual(parseDependsOn('Part of #998. Depends on #1075 and #1074. Blocked by #1081. See #1090.').issues, [1074, 1075, 1081]);
    assert.deepEqual(parseDependsOn(null), { issues: [], parts: [] });
  });
});

describe('parseClosingRefs', () => {
  it('finds every closing keyword form, and lists after one keyword', () => {
    assert.deepEqual(parseClosingRefs('Closes #1. fixes #2, Resolved: #3. Refs #4. closed #5'), [1, 2, 3, 5]);
    assert.deepEqual(parseClosingRefs('Closes #10, #11 and #12. See #13.'), [10, 11, 12]);
  });
});

describe('formatLine', () => {
  const siblings = [
    { number: 1, state: 'closed', title: 'Thing 1/3' },
    { number: 2, state: 'open', title: 'Thing 2/3' },
    { number: 3, state: 'open', title: 'Thing 3/3' },
  ];

  it('marks an open sub-issue ready only when every dependency is closed, resolving part numbers', () => {
    const ctx = buildContext(siblings);
    assert.equal(formatLine({ number: 3, state: 'open', title: 'Thing 3/3', body: 'Depends on #1.' }, ctx), '#3 open   Thing 3/3 | deps: #1 closed | ready');
    const waiting = formatLine({ number: 3, state: 'open', title: 'Thing 3/3', body: '## Depends on\n\n1/3, 2/3.' }, ctx);
    assert.match(waiting, /deps: #1 closed, #2 open \| waiting on a dependency$/);
    assert.match(formatLine({ number: 3, state: 'open', title: 'T', body: '## Depends on\n\n7/9' }, ctx), /deps: part 7 \?/);
  });

  it('reports GitHub dependency links, the closing PR, a PR that only mentions it, and not-planned', () => {
    const ctx = buildContext(siblings, { closedBy: new Map([[1, 42]]), mentionedBy: new Map([[4, 43]]) });
    assert.match(formatLine({ number: 2, state: 'open', title: 'T', body: '', issue_dependencies_summary: { blocked_by: 1 } }, ctx), /blocked by 1 open GitHub dependency link/);
    assert.match(formatLine({ number: 1, state: 'closed', title: 'T', body: '' }, ctx), /closed by PR #42$/);
    assert.match(formatLine({ number: 4, state: 'closed', title: 'T', body: '' }, ctx), /closed by hand; merged PR #43 mentions it$/);
    assert.match(formatLine({ number: 5, state: 'closed', state_reason: 'not_planned', title: 'T', body: '' }, ctx), /closed as not planned$/);
    assert.match(formatLine({ number: 6, state: 'closed', title: 'T', body: '' }, ctx), /closing PR not found$/);
  });
});

describe('the command', () => {
  it('lists a saved get_sub_issues result, wrapped or not, in part order', async () => {
    await withTempDir(async (dir) => {
      const issues = [
        { number: 11, state: 'open', title: 'Thing 2/2: b', body: '## Depends on\n\n1/2' },
        { number: 10, state: 'open', title: 'Thing 1/2: a', body: '## Depends on\n\nNone.' },
      ];
      const wrapped = path.join(dir, 'wrapped.json');
      await writeFile(wrapped, JSON.stringify([{ type: 'text', text: JSON.stringify(issues) }]));
      const out = execFileSync('node', [SCRIPT, '9', '--from-file', wrapped], { encoding: 'utf8' }).trim().split('\n');
      assert.deepEqual(out, [
        '#10 open   Thing 1/2: a | deps: none | ready',
        '#11 open   Thing 2/2: b | deps: #10 open | waiting on a dependency',
        '2 sub-issue(s) of #9, 0 closed',
      ]);
    });
  });

  it('finds sub-issues and their closing PRs through gh search, keeping only the parent\'s children', async () => {
    await withTempDir(async (dir) => {
      const parent = 'https://api.github.com/repos/o/r/issues/9';
      const issues = [
        { number: 10, state: 'closed', title: 'Thing 1/3', body: 'Part of #9.', parent_issue_url: parent },
        { number: 11, state: 'closed', title: 'Thing 2/3', body: 'Part of #9.', parent_issue_url: parent },
        { number: 12, state: 'open', title: 'Thing 3/3', body: 'Part of #9.\n\n## Depends on\n\n1/3, 2/3.', parent_issue_url: parent },
        { number: 13, state: 'open', title: 'Mentions #9 but belongs elsewhere', body: 'See #9.', parent_issue_url: 'https://api.github.com/repos/o/r/issues/99' },
      ];
      const prs = [{ number: 20, body: 'Closes #10' }, { number: 21, body: 'Covers 2/3 (#11).' }];
      // The stub prints one JSON item per line, as `gh api … --jq '.items[]'` does.
      const stub = `#!/usr/bin/env node
const q = process.argv.find((a) => a.startsWith('q=')) ?? '';
const items = q.includes('is:pr') ? ${JSON.stringify(prs)} : ${JSON.stringify(issues)};
for (const i of items) console.log(JSON.stringify(i));
`;
      await writeFile(path.join(dir, 'gh'), stub);
      await chmod(path.join(dir, 'gh'), 0o755);
      const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
      const out = execFileSync('node', [SCRIPT, '9', '--repo', 'o/r'], { encoding: 'utf8', env }).trim().split('\n');
      assert.deepEqual(out, [
        '#10 closed Thing 1/3 | deps: none | closed by PR #20',
        '#11 closed Thing 2/3 | deps: none | closed by hand; merged PR #21 mentions it',
        '#12 open   Thing 3/3 | deps: #10 closed, #11 closed | ready',
        '3 sub-issue(s) of #9, 2 closed (found by search: compare with the parent\'s sub_issues_summary.total)',
      ]);
    });
  });
});
