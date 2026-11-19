// Tests for list-sub-issues.mjs's parsing and formatting (no network). Not part of `npm test`; run
// after changing the script:
//
//   node --test .claude/skills/work-sub-issue/selftest.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatLine, parseClosingRefs, parseDependsOn } from './list-sub-issues.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'list-sub-issues.mjs');

describe('parseDependsOn', () => {
  it('reads the "## Depends on" section up to the next heading', () => {
    const body = 'Part of #998.\n\n## Depends on\n\n- #1071 (colours)\n- #1073\n\n## Acceptance\n\nSee #1080.';
    assert.deepEqual(parseDependsOn(body), [1071, 1073]);
  });

  it('treats "None." as no dependencies, and reads a section at the end of the body', () => {
    assert.deepEqual(parseDependsOn('Part of #998.\n\n## Depends on\n\nNone.\n\n## Acceptance\n\n- ok'), []);
    assert.deepEqual(parseDependsOn('Part of #998.\n\n### Depends on\n#1072'), [1072]);
  });

  it('reads inline "Depends on" and "Blocked by" mentions but not other references', () => {
    assert.deepEqual(parseDependsOn('Part of #998. Depends on #1075 and #1074. Blocked by #1081. See #1090.'), [1074, 1075, 1081]);
    assert.deepEqual(parseDependsOn(null), []);
  });
});

describe('parseClosingRefs', () => {
  it('finds every closing keyword form', () => {
    assert.deepEqual(parseClosingRefs('Closes #1. fixes #2, Resolved: #3. Refs #4. closed #5'), [1, 2, 3, 5]);
  });
});

describe('formatLine', () => {
  const states = new Map([[1, 'closed'], [2, 'open'], [3, 'open']]);
  it('marks an open sub-issue ready only when every dependency is closed', () => {
    const ready = formatLine({ number: 3, state: 'open', title: 'Part 3/3', body: 'Depends on #1.' }, states, new Map());
    assert.equal(ready, '#3 open   Part 3/3 | deps: #1 closed | ready');
    const waiting = formatLine({ number: 3, state: 'open', title: 'Part 3/3', body: 'Depends on #1 and #2' }, states, new Map());
    assert.match(waiting, /deps: #1 closed, #2 open \| waiting on a dependency$/);
  });

  it('reports GitHub dependency links and the closing PR', () => {
    const blocked = { number: 2, state: 'open', title: 'Two', body: '', issue_dependencies_summary: { blocked_by: 1 } };
    assert.match(formatLine(blocked, states, new Map()), /blocked by 1 open GitHub dependency link/);
    assert.match(formatLine({ number: 1, state: 'closed', title: 'One', body: '' }, states, new Map([[1, 42]])), /closed by PR #42$/);
  });
});

describe('--from-file', () => {
  it('lists a saved get_sub_issues result, wrapped or not, in part order', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sub-issues-'));
    try {
      const issues = [
        { number: 11, state: 'open', title: 'Thing 2/2: b', body: '## Depends on\n\n#10' },
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
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
