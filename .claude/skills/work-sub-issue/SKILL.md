---
name: work-sub-issue
description: Takes one numbered sub-issue of a BCUK Bot 4 parent issue (e.g. "Dashboard refresh 3/13" under #998) from recheck to a green PR - dependency and freshness checks, an advisor plan where the work is risky, tests, ui-check for visible changes, a security review for auth/SSE changes, an acceptance check and ticking it off on the parent. Use when starting work on any sub-issue.
---

# Working a sub-issue

One sub-issue, one branch, one PR. The parent issue holds the full design; the sub-issue holds this part's scope.

## 1. Before writing code
- **List the parts compactly first; never pull every sub-issue body at once** (the MCP `get_sub_issues` call returns them all: about 167k characters for #998's 13 parts):
  ```bash
  node .claude/skills/work-sub-issue/list-sub-issues.mjs <parent>
  ```
  One line per sub-issue: number, state, title, its "Depends on" list with each dependency's state, then `ready`, `waiting on a dependency`, or the merged PR that closed it. It reads through `gh api search/issues`, the only `gh` use cloud sessions allow. Check the count it prints against the parent's `sub_issues_summary.total` (from the MCP `issue_read` `get` of the parent, below). If they differ, a sub-issue doesn't mention its parent in its body: make the MCP `get_sub_issues` call for the parent, let its oversized result be saved to a file, and run the script with `--from-file <that file>` instead of reading the result.
- Then read in full, with MCP `issue_read`: the parent (`get`), its progress comments (`get_comments`: the dated notes on which part merged in which PR and which later part took over a deferred item, e.g. from #1101 → #1075), and only the **chosen** sub-issue (`get`). The parent's "Must keep", "Initial scope boundary" and constraints apply to every part.
- **Order:** a sub-issue whose dependencies are all closed can be taken in any order (true of every #998 part), unless the parent says otherwise.
- **Dependencies:** check every issue in its "Depends on" list is closed (its PR merged); the listing shows this. If one isn't, stop and tell the user which.
- **Freshness** (`issue-management` skill): check the file paths, line counts and defaults the issue names against current `main`. If they've drifted, add a dated recheck note with the new sha before starting.
- **Scope:** list what this part does and, explicitly, what belongs to other parts. Don't pull work forward from a later sub-issue.
- **Ask `advisor` for a plan** when the part touches the server side (routes, SSE, auth, caches, the status payload) or more than a couple of modules. Give it the sub-issue, the parent and the files. Skip it for a pure styling or markup change.
- Anything the issue marks as needing explicit approval (e.g. "additive server change … needs approval") is the user's call: ask before building it.

## 2. Build
- Tests first where the issue pins the behaviour down (e.g. the own-channel-not-duplicated cases, the SSE close cases). Views: `src/web/<view>View.test.ts`; browser scripts: `src/web/<script>Script.test.ts`; routes/SSE: the route's test. Follow `views/CLAUDE.md` (front end) and `src/web/CLAUDE.md` (routes).
- **Visible changes:** run the `ui-check` skill with a fixture per state the issue lists (a few-line variant that `extends` an existing fixture; see its "Fixtures" section). Fix any CSP violation, overflow or reduced-motion animation it reports.
- **Auth, session or SSE changes** (e.g. closing streams on sign-out or guild change, membership pushes): run the built-in `/security-review` on the branch before opening the PR, and treat its findings as blocking.

## 3. Before the PR leaves draft
- Run the `precommit` skill.
- Run the `acceptance-checker` agent with the issue number. Every row must be **proven**, or listed in the PR description as out of scope with the sub-issue that covers it. Then run `node .claude/hooks/workflow-state.mjs record acceptance`; the PR can't leave draft until you do.
- PR title: the sub-issue's title. Body: what changed, the acceptance table, `ui-check` screenshots (before and after) for visible changes, and `Closes #<sub-issue>`.
- Then follow the `drive-pr` skill until it's green.

## 4. After it merges
- Have `issue-gardener` tick the part off on the parent (strike through or tick, saying when and in which PR) and update any later sub-issue whose premise this part changed.
- If this was the last open sub-issue, the parent is complete: say so to the user rather than closing it yourself.
