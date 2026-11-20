---
name: ui-check
description: Renders a BCUK Bot 4 web panel page (an EJS view) from fixture data in the pre-installed Chromium, without starting the bot, and reports CSP violations, script errors, failed requests, horizontal overflow and content clipped at the viewport edge, animations still running under reduced motion, focus stops without a visible indicator and text below WCAG AA contrast, with desktop/tablet/mobile, reduced-motion and greyscale screenshots plus an ARIA snapshot. Use for any change to views/ or public/, and to check responsive, reduced-motion, non-colour, focus and contrast acceptance criteria.
---

# ui-check

```bash
node .claude/skills/ui-check/render.mjs <fixture.json> [outDir] [--no-a11y]
```

The output defaults to `ui-check-output/<view>/` (gitignored). Exit code 1 means a CSP violation or an uncaught page error; fix those before going further. The focus and contrast audits are report-only: they never change the exit code, and the last line printed sums them up.

## Fixtures
A fixture is JSON: `{ "view": "dashboard", "locals": {…}, "api": {"/path": json}, "sse": {"/path": [{"event"?, "data"}]}, "waitMs": 800 }`.
- `locals` are what the route passes to `renderView`, plus `user` and `csrfToken`. Copy the shape from the route and the view's test, not from memory.
- `api` stubs the page's `fetch` calls and `sse` stubs its `EventSource` streams (events sent once, then held open). Any other path without a file extension answers 503, so the page shows its unavailable state.
- **`extends`**: `"extends": "dashboard.json"` (relative to this fixture) loads that fixture and deep-merges this one over it: objects merge key by key; arrays, scalars and `null` replace; `"$remove"` deletes an inherited key. Write a new state as a few-line variant, not a copy, so it doesn't drift from its base.
- **`status` + `statusPaths`**: `status` is one status payload that is deep-merged into `locals.status` (initial render), into each `api` stub listed in `statusPaths.api` (fetch) and into every event of each `sse` stub listed in `statusPaths.sse` (stream; an empty stream gets one event). A page that receives the same payload three ways would otherwise apply the stock value from whichever path wasn't patched. `dashboard.json` declares `statusPaths` for `/api/status` and `/dashboard/status/events`, so a dashboard variant only states what differs: `{ "extends": "dashboard.json", "status": { "discord": { "ready": false } } }`. Another view can use the same keys with its own paths.
- **`clock`**: `{ "advanceMs": 200000, "stepMs": 10000 }` installs Playwright's fake clock and, after `waitMs`, fast-forwards the page's timers in steps (with a short real pause between them so network replies land), so states behind slow timers, such as the 60s status poll, appear in seconds.
- Checked-in dashboard fixtures, all illustrative data:
  - `dashboard.json`: mixed channel states (live with the bot disconnected, live and connected, offline and connected, never seen).
  - `dashboard-discord-down.json`: the Discord bot not ready.
  - `dashboard-voice-playing.json`: a sound playing in voice.
  - `dashboard-all-connected.json`: every Twitch channel's bot connected.
  - `dashboard-owner-long-names.json`: the widest nav the panel renders (the Owner's menu, the server switcher, a 32-character Discord name and a 100-character server name). Its desktop and tablet runs must show no `clippedContent`; the selftest also sweeps its widths from 641 to 1700px.
  - `dashboard-busy-feed.json`: 40 recent events, so the event feed is the tallest column and sets the page height. Its desktop run must report `verticalOverflow: "none"`; the selftest sweeps desktop heights from 900 to 1200px. Below about 900px the main column is itself taller than the viewport, so the page scrolls by design.
  - `dashboard-feed-unavailable.json`: no status stubs (`"statusPaths": "$remove"`), so `/api/status` and the stream answer 503; the clock advances past three failed polls to reach "Status unknown". Without the clock this takes 2–3 minutes, because a 503 closes `EventSource` for good.

  Add a variant for any other state you need (signed out, no channels, a Manager user with the reconnect modal), and keep fixture data obviously illustrative.

## What to check
1. **`report.json`** for each run: `cspViolations` and `consoleErrors` must be empty, `failedRequests` should only list deliberately unstubbed paths, `horizontalOverflow` must be `none` and `clippedContent` empty at every width, `verticalOverflow` (how far the page is taller than the viewport) must be `none` on the 1440x900 desktop run of a page that sizes itself to the viewport (the dashboard does, so use `dashboard-busy-feed.json`; tablet and mobile stack and scroll by design), and the `*-reduced-motion` runs must list no `runningAnimations`.
   `clippedContent` lists visible text and controls that sit partly past the viewport's side edges. It catches what `horizontalOverflow` can't: the panel sets `overflow-x: clip` on `html` and `body`, so overflowing content is cut off rather than scrollable, and the document never reports a scroll width. Content inside an element that clips or scrolls on its own (`.table-scroll`, the feeds) isn't counted.
2. **`a11y.focus`** (desktop, tablet and mobile runs): Tab is pressed from the top of the page until focus comes back to an element already visited; on a narrow layout the nav toggle is opened first. `visited` is the number of distinct stops and `missingIndicator` lists each stop with no visible `outline` (non-zero width, not transparent) or `box-shadow` ring when focused. `truncated: true` means the 250-stop cap ran out before focus cycled.
3. **`a11y.contrast`** (every run but greyscale, so the reduced-motion runs also catch a colour that is only fine mid-animation): every visible element with direct text has its `color` measured against its effective background, found by alpha-blending translucent ancestor backgrounds down to the first opaque one. `failures` lists those under 4.5:1, or 3:1 for large text (≥ 24px, or ≥ 18.66px bold), with the colours and ratio. Visually hidden (1px) text and disabled controls are skipped.
4. **Screenshots** (`desktop`, `tablet`, `mobile`, plus `*-reduced-motion` and `*-greyscale` at desktop and mobile): look at them. In greyscale every status must still be readable from its text and icon. The greyscale filter is set through the DOM, so that run enforces the CSP too.
5. **`aria-snapshot.yml`** (desktop): headings in order, labelled controls, statuses announced as text.

**Audit limits** (check these by eye): text over a background image or gradient is listed under `contrast.unverifiable`, not measured; an element's background is taken from its DOM ancestors, so text positioned over a sibling is measured against the wrong layer; `opacity` is multiplied into the text colour only, which is exact when the faded element has no background of its own; animated colours are sampled at one moment; a focus indicator drawn only by a border, background or underline change counts as missing; and the focus ring's own contrast isn't measured.

Attach the relevant screenshots to the PR (before and after for visual changes). Put them in the PR body via the GitHub UI or describe them; don't commit them.

The script copies the production CSP from `src/web/server.ts`: when that CSP changes, update `CSP` in `render.mjs` too.

After changing anything in this folder, run its own tests: `node --test .claude/skills/ui-check/selftest.mjs` (fixture merging, the variants rendering their states, the audits catching a link with `outline: none` and grey-on-grey text, and clipped content). They aren't part of `npm test`, because Playwright isn't a project dependency; the `precommit` script runs them when this folder changes.

## Known findings on `main` (Nov 2026)
- A channel that is live while its bot is disconnected shows no LIVE badge (#998, #1077).
- `.disclosure-toggle:focus-visible` uses `--primary` instead of `--focus-ring` (`public/style.css`). The focus audit passes it, since it has an outline; only its colour is off.
