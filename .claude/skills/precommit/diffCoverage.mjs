// diffCoverage: finds the lines a branch adds to non-test source files that no test ran, so the
// gap Qlty reports as "diff coverage" shows up before the push instead of in a review round.
// Pure parsing helpers; precommit.mjs feeds them `git diff -U0` output and an lcov report.

const SOURCE_FILE = /^src\/.*\.ts$/;
const TEST_FILE = /\.test\.ts$|^src\/(__tests__|test-utils)\//;

/**
 * Says whether Qlty would count a path's lines towards diff coverage.
 * @param file repository-relative path
 * @returns true for a non-test TypeScript file under src/
 */
export function isCoverable(file) {
  return SOURCE_FILE.test(file) && !TEST_FILE.test(file) && !file.endsWith('.d.ts');
}

/**
 * Reads the added line numbers of each coverable file from a zero-context unified diff.
 * @param diff output of `git diff -U0` (paths prefixed `b/`)
 * @returns each coverable file's added line numbers
 */
export function addedLines(diff) {
  const added = new Map();
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const name = line.startsWith('+++ b/') ? line.slice(6) : null;
      file = name && isCoverable(name) ? name : null;
      if (file && !added.has(file)) added.set(file, new Set());
      continue;
    }
    const hunk = file ? /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line) : null;
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let n = start; n < start + count; n++) added.get(file)?.add(n);
  }
  return added;
}

/**
 * Reads the per-line hit counts from an lcov report.
 * @param lcov contents of lcov.info
 * @param root absolute path of the repository, stripped from the report's absolute paths
 * @returns each file's map of line number to hit count (only lines the report tracks)
 */
export function parseLcov(lcov, root) {
  const prefix = `${root.replaceAll('\\', '/').replace(/\/$/, '')}/`;
  const files = new Map();
  let hits = null;
  for (const raw of lcov.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const name = line.slice(3).replaceAll('\\', '/');
      hits = new Map();
      files.set(name.startsWith(prefix) ? name.slice(prefix.length) : name, hits);
    } else if (line.startsWith('DA:') && hits) {
      const [n, count] = line.slice(3).split(',');
      hits.set(Number(n), Number(count));
    }
  }
  return files;
}

/**
 * Finds the added lines that the coverage report tracks but no test ran. A line the report
 * doesn't track (a comment, a type, a blank) is not executable and isn't counted.
 * @param added what addedLines returned
 * @param covered what parseLcov returned
 * @returns each file's uncovered added lines, sorted; files with none are left out. A file
 *   missing from the report entirely (no test imported it) lists all its added lines as `null`
 */
export function uncoveredAdded(added, covered) {
  const result = new Map();
  for (const [file, lines] of added) {
    const hits = covered.get(file);
    if (!hits) {
      result.set(file, null);
      continue;
    }
    const missed = [...lines].filter((n) => hits.get(n) === 0).sort((a, b) => a - b);
    if (missed.length) result.set(file, missed);
  }
  return result;
}

/**
 * Collapses sorted line numbers into ranges.
 * @param lines ascending line numbers
 * @returns text such as `4-6, 9`
 */
export function formatRanges(lines) {
  const ranges = [];
  for (const n of lines) {
    const last = ranges.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(', ');
}

/**
 * Renders the uncovered lines as the report precommit prints.
 * @param uncovered what uncoveredAdded returned
 * @returns the report lines, empty when everything added is covered
 */
export function formatReport(uncovered) {
  return [...uncovered].map(([file, lines]) => (lines
    ? `  ${file}: ${formatRanges(lines)}`
    : `  ${file}: no test loads this file`));
}
