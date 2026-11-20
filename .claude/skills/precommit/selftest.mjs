// Tests for diffCoverage.mjs. Not part of `npm test`; precommit.mjs runs them when this folder
// changes, or run them directly:
//
//   node --test .claude/skills/precommit/selftest.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addedLines, formatRanges, formatReport, isCoverable, parseLcov, uncoveredAdded } from './diffCoverage.mjs';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -3,0 +4,2 @@ context',
  '+x',
  '+y',
  '@@ -10 +12 @@',
  '-old',
  '+new',
  '@@ -20,2 +21,0 @@',
  'diff --git a/src/a.test.ts b/src/a.test.ts',
  '--- a/src/a.test.ts',
  '+++ b/src/a.test.ts',
  '@@ -0,0 +1 @@',
  '+t',
  'diff --git a/src/gone.ts b/src/gone.ts',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
].join('\n');

describe('isCoverable', () => {
  it('counts source files and skips tests, helpers and declarations', () => {
    assert.equal(isCoverable('src/a.ts'), true);
    assert.equal(isCoverable('src/a.test.ts'), false);
    assert.equal(isCoverable('src/__tests__/a.ts'), false);
    assert.equal(isCoverable('src/test-utils/a.ts'), false);
    assert.equal(isCoverable('src/types.d.ts'), false);
    assert.equal(isCoverable('views/a.ts'), false);
  });
});

describe('addedLines', () => {
  it('collects added line numbers per source file, ignoring removals, tests and deleted files', () => {
    const added = addedLines(DIFF);
    assert.deepEqual([...added.keys()], ['src/a.ts']);
    assert.deepEqual([...(added.get('src/a.ts') ?? [])], [4, 5, 12]);
  });
});

describe('parseLcov', () => {
  it('maps lines to hits and strips the repository root', () => {
    const files = parseLcov('SF:/repo/src/a.ts\nDA:4,0\nDA:5,3\nend_of_record\n', '/repo');
    assert.deepEqual([...(files.get('src/a.ts') ?? [])], [[4, 0], [5, 3]]);
  });
});

describe('uncoveredAdded', () => {
  const added = new Map([['src/a.ts', new Set([4, 5, 6, 12])], ['src/b.ts', new Set([1])], ['src/c.ts', new Set([1])]]);
  const covered = parseLcov('SF:/r/src/a.ts\nDA:4,0\nDA:5,2\nDA:12,0\nend_of_record\nSF:/r/src/c.ts\nDA:1,1\nend_of_record\n', '/r');

  it('reports only tracked lines with no hits, and files no test loaded', () => {
    const result = uncoveredAdded(added, covered);
    assert.deepEqual(result.get('src/a.ts'), [4, 12]); // 6 isn't executable, 5 is covered
    assert.equal(result.get('src/b.ts'), null);
    assert.equal(result.has('src/c.ts'), false);
  });

  it('formats ranges and the report', () => {
    assert.equal(formatRanges([1, 2, 3, 7, 9, 10]), '1-3, 7, 9-10');
    assert.deepEqual(formatReport(uncoveredAdded(added, covered)), ['  src/a.ts: 4, 12', '  src/b.ts: no test loads this file']);
  });
});
