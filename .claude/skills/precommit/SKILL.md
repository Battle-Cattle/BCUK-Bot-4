---
name: precommit
description: Runs BCUK Bot 4's "ALWAYS - Before Committing" checks on the current branch - typecheck, the tests for what changed (or the full suite when shared infrastructure changed) and ESLint on changed files. Use before every commit in this repo.
---

# Pre-commit checks

This is the procedure behind `CLAUDE.md`'s "ALWAYS: Before Committing". CI remains the gate.

1. **Node 24.** If `node -v` isn't 24.x, switch first (`CLAUDE.md` "Node/npm version"). Don't debug an `npm` failure before checking this.

2. **Pick the test scope.** The full suite is needed when the diff against `origin/main` (committed, staged, unstaged and untracked) touches shared infrastructure:

   ```bash
   git fetch -q origin main
   changed=$( { git diff --name-only origin/main...HEAD; git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u)
   if echo "$changed" | grep -qE '^(src/db\.ts|migrations/|DATABASE-SCHEMA\.md|src/shared/|src/test-utils/|package(-lock)?\.json|tsconfig[^/]*|vitest[^/]*|eslint[^/]*)'; then
     echo FULL
   else
     echo CHANGED
   fi
   ```

3. **Run, in one Bash call so failures surface together:**

   ```bash
   npm run typecheck
   npm test                                  # if FULL
   npx vitest run --changed origin/main      # if CHANGED
   base=$(git merge-base origin/main HEAD)
   files=$( { git diff --name-only --diff-filter=d "$base" -- '*.ts' '*.js' '*.mjs' '*.mts'; git ls-files --others --exclude-standard -- '*.ts' '*.js' '*.mjs' '*.mts'; } | sort -u)
   [ -n "$files" ] && npx eslint $files
   ```

   The ESLint list is every file this branch adds or changes (committed, staged, unstaged and untracked) minus deletions, measured from the merge base so files that only changed on `main` aren't linted. `vitest --changed` already counts untracked files. Not `npx tsc` (`CLAUDE.md` "TypeScript 6 + 7").

4. **On failure:** fix it yourself when it's in code you just wrote. Hand a batch of lint/JSDoc findings in several files to the `lint-docs-fixer` subagent with the file paths and the eslint output, then review its diff. Rerun step 3 until it's clean.

5. If a migration or a DB module's SQL changed and Docker is available, also run `npm run test:db`; otherwise say it's left to CI.

Report the scope you chose and each command's result in one or two lines.
