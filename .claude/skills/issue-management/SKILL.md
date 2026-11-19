---
name: issue-management
description: BCUK Bot 4's rules for GitHub issues - severity labels vs the Priority and Effort fields, splitting large issues into sub-issues, and keeping issues up to date. Use when creating, triaging, splitting, rechecking or closing an issue in this repo.
---

# GitHub Issues

Every issue has three independent ratings:

- **Severity = impact**: how much it matters if it's never done (or how bad the bug is). It's a label: `severity:critical`/`severity:high`/`severity:medium`/`severity:low`. Titles don't need a severity prefix. Add a type label too (`bug`, `enhancement`, `documentation`, `security`, …).
- **Priority = urgency**: how soon it should be done. It's the org-level **Priority** issue field (`Urgent`/`High`/`Medium`/`Low`), not a label or title prefix. Every open issue has one.
- **Effort = size of the work**: how much it takes to finish. It's the org-level **Effort** issue field (`High`/`Medium`/`Low`), set alongside Priority whenever an issue is created or triaged. Every open issue has one.
  - `Low`: one small, focused PR (a contained fix, a doc or config change).
  - `Medium`: one PR touching several files or a module's tests and docs.
  - `High`: several PRs or a cross-module change. A `High` issue is a candidate for splitting into sub-issues.

The three can differ (e.g. a low-impact fix that's wanted soon, a high-impact feature that can wait, or an urgent change that's small). Don't "correct" one to match another. When an issue is re-scoped or its plan changes, recheck its Effort.

**Large issues are split into sub-issues**, linked as real GitHub sub-issues (not just mentioned in the body):

- Title: `<parent topic> n/N: <what this part does>`, e.g. `Faster test suite 2/4: sub-second, configurable polling in deploy.sh`. Mark optional parts `(optional)`.
- Body: which parent it's part of and which step of the parent's plan it covers, its scope, tests, and a "Depends on" list of the other parts it needs. The full design stays in the parent.
- **Priority matches the parent.** Change the parent's and every open sub-issue's together.
- **Severity is the same as the parent's or lower**, judged on what that part delivers on its own (e.g. a read-only page that's empty until a later part lands is lower than the parts that deliver the feature). **The parent's severity is the highest of its sub-issues'**: when a sub-issue's severity changes, recheck the parent's.
- **Effort is judged per part**, on that sub-issue's own scope. **The parent's Effort covers the whole plan**, so it is at least the highest of its sub-issues' (normally `High` once it's worth splitting).
- Closing the last open sub-issue completes the parent. Close a part that turned out not to be needed as "not planned", with a note on the parent.

**Keeping issues up to date:** an issue says which commit it was checked against (``checked against `main` @ `<sha>` ``). When you recheck one, add a dated note with the new sha rather than silently rewriting it. Mark finished items as done (strike through or tick them, saying when and in which PR) instead of deleting them. When an issue's premise has changed (e.g. the code it describes was rewritten), re-scope it and keep the original description in a collapsed `<details>` block at the bottom. Before starting on an issue, check its file paths, line counts and defaults against current `main`.

## Delegating

Bulk issue work (relabelling, adding Priority or Effort to many issues, rechecking several issues against `main`) can go to the `issue-gardener` subagent (Sonnet). Splitting a large issue into a sub-issue plan is a design decision: ask the `advisor` subagent for the split first, then have `issue-gardener` create and link the sub-issues.
