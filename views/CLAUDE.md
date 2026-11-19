# Front-end rules: `views/` and `public/`

Loaded when working in `views/`; the root `CLAUDE.md` points here for `public/` too. (No `CLAUDE.md` lives in `public/`: everything there is served to the internet.) Server routes are in `src/web/` (see `src/web/CLAUDE.md`).

## Content Security Policy
`helmet` in `src/web/server.ts` allows scripts and styles from `'self'` only, with `script-src-attr 'none'`. So: **no inline `<script>`, no `on*=` attributes, no `style="…"` attributes and no `<style>` blocks.** Behaviour goes in a `public/*.js` file loaded with `<script src>`; styling goes in `public/style.css`. No `eval`/`new Function`. Images only from `'self'`, `data:`, `cdn.discordapp.com` and `static-cdn.jtvnw.net`; `fetch` and SSE only to the same origin. The `ui-check` skill enforces this CSP and reports violations.

## EJS views (`views/`)
- **Escaping:** use `<%= %>`. `<%- %>` is only for `include(...)` and for values already made safe on purpose, with a comment saying why (e.g. `htmlAttrJson()` for `data-*` JSON, which escapes the value itself).
- **Page data for scripts** goes in `data-*` attributes on `<body>` (e.g. `data-initial-status`, `data-csrf-token`). Never write data into an inline script.
- **Forms** that POST carry `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`. Field names are part of the route's contract: don't rename one without changing the route.
- **Shared pieces** live in `views/partials/` (`head`, `nav`, `footer`, `page-end`, …): change a shared look there, not per page. `renderView` only accepts views that exist in `views/`.
- **Role gating** in a template mirrors the route's: hide a control from a user who can't use it, but the route still enforces the access level.

## Browser scripts (`public/*.js`)
- **Classic scripts, no bundler, no modules.** A page loads its scripts in order, and top-level functions are shared between the scripts on that page. A name used from another script goes in a `/* global name */` header (`name:writable` if assigned). ESLint applies browser globals, `eqeqeq` and the same JSDoc rules as `src/`.
- **Requests:** `fetch` POSTs send `X-CSRF-Token` from `document.body.dataset.csrfToken`. Treat a 401 as "session expired" (see `dashboard-voice.js`), and after repeated failures show an explicit unavailable state rather than leaving old values on screen as if current.
- **SSE:** use the existing `EventSource` endpoints and `sseClient.js`; don't add polling where a stream exists.

## Styling (`public/style.css`)
One stylesheet, with design tokens in `:root` (`--bg`, `--primary`, `--success`, `--danger`, `--warning`, …): use them, not new hex values. Green/amber/red are for operational states only. Every status needs a text label and a non-colour cue. Every animation and transition must stop under `@media (prefers-reduced-motion: reduce)`: the global block at the end of `style.css` does this for the panel (overlays have their own stylesheets), so don't add an `!important` animation that would beat it. An animation must not take text below AA at any frame: animate a background, not the opacity of a badge with text. A status dot needs a distinct shape per state plus `role="img"` and an `aria-label` (`setStatusDot` in `dashboard-utils.js`). A card's state in words uses `setStatusText` (`dashboard-status.js`) and a `.status-text--*` modifier for its icon and colour, never an inline `style.color`. Red/amber mark a required service's fault only; informational states (idle or disconnected voice) stay neutral or brand-coloured.

## Tests and checks
- A view's `src/web/<view>View.test.ts` renders it with `ejs.renderFile` and asserts on the HTML (see `dashboardView.test.ts`); cover every state the page can show (empty, signed out, each access level, each status).
- A script's `src/web/<script>Script.test.ts` runs it with `vm` in a stub context (fake `document`, `fetch`, timers) and asserts on what it renders or requests (see `dashboardVoiceScript.test.ts`).
- For any visible change, run the `ui-check` skill and put its screenshots in the PR.
