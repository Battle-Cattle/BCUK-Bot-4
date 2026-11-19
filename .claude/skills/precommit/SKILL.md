---
name: precommit
description: Runs BCUK Bot 4's "ALWAYS - Before Committing" checks on the current branch - typecheck, the tests for what changed (or the full suite when shared infrastructure changed), the self-tests of changed skills and ESLint on changed files. Use before every commit in this repo.
---

# Pre-commit checks

This is the procedure behind `CLAUDE.md`'s "ALWAYS: Before Committing". CI remains the gate.

1. **Node 24.** If `node -v` isn't 24.x, switch first (`CLAUDE.md` "Node/npm version"). The script refuses to run on another major.

2. **Run the checks:**

   ```bash
   node .claude/skills/precommit/precommit.mjs          # add --full to force the full suite
   ```

   It fetches `origin/main` and runs `npm run typecheck`, then the tests, then any skill self-tests, then ESLint, reporting every failure rather than stopping at the first:
   - **Tests:** the full `npm test` when anything the branch changes (committed, staged, unstaged or untracked) is shared infrastructure: `src/db.ts`, `migrations/`, `DATABASE-SCHEMA.md`, `src/shared/`, `src/test-utils/`, `package(-lock).json`, or a `tsconfig*`/`vitest*`/`eslint*` file. That includes test-only changes under those paths. Otherwise `npx vitest run --changed origin/main`.
   - **Skill self-tests:** `node --test .claude/skills/<name>/selftest.mjs` for each skill folder the branch changes that has one (they're outside Vitest's `src/**` include). One that loads Playwright is skipped, with a note, where the pre-installed Playwright isn't available.
   - **ESLint:** every `.ts`/`.js`/`.mjs`/`.mts` file the branch adds or changes, measured from the merge base so files that only changed on `main` aren't linted.

   Don't run these commands by hand instead: only the script records a pass. Not `npx tsc` (`CLAUDE.md` "TypeScript 6 + 7").

3. **On failure:** fix it yourself when it's in code you just wrote. Hand a batch of lint/JSDoc findings in several files to the `lint-docs-fixer` subagent with the file paths and the eslint output, then review its diff. Rerun step 2 until it passes.

4. **Commit what was checked.** On a pass the script records a hash of the working tree it checked (tracked and untracked files, minus ignored ones) in `.git/claude-workflow/precommit.json`. The commit hook (`.claude/hooks/workflow-guard.mjs`) allows `git commit` only while the working tree still matches it, so any edit after a pass, even to a test file, needs another run. Commit in a Bash call of its own (`git add` before it is fine): the hook checks the tree from before the command line runs. If files change while the checks run, nothing is recorded.

5. If a migration or a DB module's SQL changed and Docker is available, also run `npm run test:db`; otherwise say it's left to CI.

Report the scope the script chose and each check's result in one or two lines.
