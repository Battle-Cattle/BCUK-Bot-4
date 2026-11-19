---
name: ui-check
description: Renders a BCUK Bot 4 web panel page (an EJS view) from fixture data in the pre-installed Chromium, without starting the bot, and reports CSP violations, script errors, failed requests, horizontal overflow and animations still running under reduced motion, with desktop/tablet/mobile, reduced-motion and greyscale screenshots plus an ARIA snapshot. Use for any change to views/ or public/, and to check responsive, reduced-motion and non-colour acceptance criteria.
---

# ui-check

```bash
node .claude/skills/ui-check/render.mjs <fixture.json> [outDir]
```

The output defaults to `ui-check-output/<view>/` (gitignored). Exit code 1 means a CSP violation or an uncaught page error; fix those before going further.

## Fixtures
A fixture is JSON: `{ "view": "dashboard", "locals": {…}, "api": {"/path": json}, "sse": {"/path": [{"event"?, "data"}]}, "waitMs": 800 }`.
- `locals` are what the route passes to `renderView`, plus `user` and `csrfToken`. Copy the shape from the route and the view's test, not from memory.
- `api` stubs the page's `fetch` calls and `sse` stubs its `EventSource` streams (events sent once, then held open). Any other path without a file extension answers 503, so the page shows its unavailable state.
- `fixtures/dashboard.json` covers the dashboard with mixed channel states: live with the bot disconnected, live and connected, offline and connected, never seen. Copy it for new states (signed out, no channels, many live channels, stale feed) rather than editing it, and keep fixture data obviously illustrative.

## What to check
1. **`report.json`** for each run: `cspViolations` and `consoleErrors` must be empty, `failedRequests` should only list deliberately unstubbed paths, `horizontalOverflow` must be `none` at every width, and the `*-reduced-motion` runs must list no `runningAnimations`.
2. **Screenshots** (`desktop`, `tablet`, `mobile`, plus `*-reduced-motion` and `*-greyscale` at desktop and mobile): look at them. In greyscale every status must still be readable from its text and icon.
3. **`aria-snapshot.yml`** (desktop): headings in order, labelled controls, statuses announced as text.

Attach the relevant screenshots to the PR (before and after for visual changes). Put them in the PR body via the GitHub UI or describe them; don't commit them.

The script copies the production CSP from `src/web/server.ts`: when that CSP changes, update `CSP` in `render.mjs` too.

## Known findings on `main` (Nov 2026)
- A channel that is live while its bot is disconnected shows no LIVE badge (#998, #1077).
