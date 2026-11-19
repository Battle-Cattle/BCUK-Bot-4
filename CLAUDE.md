# BCUK Bot 4 — Claude Code Instructions

Folder rules load when you work there: `src/web/CLAUDE.md` (middleware order, auth, access levels), `src/db/CLAUDE.md` (DB layer, SQL, migrations, DB tests) and `views/CLAUDE.md` (front end: CSP, EJS, browser scripts, styling). **For work in `public/`, read `views/CLAUDE.md` first**: `public/` is served to the internet, so it holds no `CLAUDE.md`. Task rules are skills: `precommit`, `drive-pr` (Qlty/CodeRabbit), `issue-management`, `work-sub-issue` (one numbered sub-issue to a green PR) and `ui-check` (render a page in Chromium from fixture data).

## Node/npm version

Node 24.22.3+ with npm 11+, as in `package.json` `engines` and CI. **Check `node -v`/`npm -v` before any `npm` command**: an older npm's `npm ci` fails with a spurious `Missing: <pkg>@<version> from lock file` against this valid lockfile (the `filing-cabinet`/`typescript` override), and `.npmrc`'s `engine-strict=true` refuses older Node. The SessionStart hook switches to Node 24 when the session opens in this repo; otherwise:

```bash
export NVM_DIR="${NVM_DIR:-/opt/nvm}" && source "$NVM_DIR/nvm.sh" && nvm install 24 && nvm use 24
```

In cloud sessions `node_modules` is already installed; switch Node but skip the install. `@types/node` stays on the `engines` major: bump it in the same change that moves `engines` and CI.

## ALWAYS: Before Committing

Run the `precommit` skill, which runs `node .claude/skills/precommit/precommit.mjs`: `npm run typecheck`, the tests that import a changed file, the `selftest.mjs` of any skill whose folder changed, and ESLint on every file the branch adds or changes (new untracked files included). A hook blocks `git commit` unless that script passed on exactly the working tree being committed, so running the commands by hand doesn't count.

**The script runs the full `npm test` instead** when the change touches shared infrastructure: `src/db.ts`, `migrations/` or `DATABASE-SCHEMA.md`, `src/shared/`, `src/test-utils/`, `package.json`/`package-lock.json`, a `tsconfig*`/`vitest*`/`eslint` config, or `.claude/hooks/` or `.claude/skills/precommit/`. Leave coverage, `build`, `check:circular`, `check:unused` and `test:toolchain` to CI unless you're changing what they check.

**CI is the gate, not the local run.** A PR isn't done until CI is green. If it fails, reproduce the failing check locally, fix it, and show it passing before pushing again.

## TypeScript 6 + 7

`typescript7` (`npm:typescript@7.0.2`) does all type-checking and building; `typescript` (6.x) stays installed because typescript-eslint, sonarjs, madge and ts-node need its JS API, which 7.x doesn't expose. Both ship a `tsc` bin, so **never run `npx tsc`**: use `npm run typecheck`/`npm run build`, which call the 7.x compiler by path. `src/shared/typescriptToolchain.test.ts` holds that in place, and its header explains the setup and how to move `typescript` itself to 7.x. Dependabot ignores `typescript` major updates.

## Dev

```bash
npm run dev             # ts-node src/index.ts
npm test                # Vitest (everything except the ts-node toolchain smoke test)
npm run test:toolchain  # ts-node smoke test only — slow; CI runs it
npm run test:db         # *.db.test.ts against a real MySQL (see src/db/CLAUDE.md); CI runs it
npm run lint / check:circular (madge) / check:unused (knip)
```

Tests run in Vitest's `vmThreads` pool: objects from Node built-ins come from a different realm, so assert on `.name`/`.code`, not `instanceof` against a Node built-in class. Prefer `waitFor` from `src/test-utils/waitFor.ts` over `vi.waitFor`. If a run looks stale, `rm -rf .vitest-cache`. For knip, an export used only in its own file is fine; an alias of another export needs an `@alias` JSDoc tag.

## Layout

`src/index.ts` entry point · `src/db.ts` + `src/db/` DB facade and modules · `src/discord/` bot, guild registry, voice presence · `src/twitch/` chat bot, Helix client, `eventsub/`, `monitor/`, `pricing/`, `timers/` · `src/commands/` routing, cooldowns, handlers for both platforms · `src/audio/` voice playback and SFX · `src/web/` Express app and `routes/` · `src/shared/` config, logger, crypto, mutation queues, runtime registry · `src/types/` Express type augmentation · `src/test-utils/` shared fixtures. `DATABASE-SCHEMA.md` is the schema reference; `.devin/wiki.json` is a purpose-only map.

## Code rules

- **TypeScript:** `strict` plus `noUncheckedIndexedAccess`, so `rows[0]` is `T | undefined`: guard it, or use `!` only where a nearby check guarantees it, with a comment saying which.
- **ESLint errors that shape code:** `no-floating-promises`/`no-misused-promises` (await or `void` everything), `no-console` (use `logger`), and complexity limits on source files: `sonarjs/cognitive-complexity` ≤ 15 (Qlty's metric too), `complexity` ≤ 12, `max-params` 5, `max-depth` 3, `max-nested-callbacks` 3. `public/` browser scripts are linted too: a name used from another script on the same page goes in a `/* global name */` header (`name:writable` if assigned).
- **Lightweight Discord imports:** `discord.js` costs ~300ms per test file, so take runtime values from the packages it re-exports: `discord-api-types/v10` (`ChannelType`, `Routes`, `RESTJSONErrorCodes`), `@discordjs/rest` (`DiscordAPIError`, `HTTPError`, `makeURLSearchParams`), `@discordjs/builders` (`EmbedBuilder`), `@discordjs/formatters` (`escapeMarkdown`). Types-only uses are `import type { … } from 'discord.js'`. Only `discordBot.ts` imports `discord.js` at runtime.

## Critical Invariants

- **`mediaplex` must be the first import in `src/index.ts`** — registers the Opus provider. Never reorder.
- **Import DB functions from `src/db.ts` only**, never `src/db/*` directly: it re-exports the cache-invalidating `*Writes.ts` wrappers in place of the raw writes.
- **BIGINT columns are strings** — never coerce to `Number` (exception for provably bounded values in `src/db/CLAUDE.md`).
- **Schema changes are a new numbered migration plus a `DATABASE-SCHEMA.md` update.** Never edit an applied migration.
- **`requireGuildContext` must run before any `requireAccessLevel` check** (`src/web/CLAUDE.md`). Use the `AccessLevel` const, not raw numbers.
- **POST routes redirect to `?error=code`** on failure; never render errors from a POST handler.
- **`src/discord/discordUtils.ts`** has `isDiscordNotFoundError` and `tryDeleteDiscordMessage` — import, don't duplicate.

## Startup Sequence (`src/index.ts`)

Boot order in `main()`: DB ping → migrations → re-encrypt stored OAuth tokens (catch-and-log) → wire Twitch/EventSub callbacks → `reloadGuildRegistry()` (before Discord connects) → Discord bot → Twitch bot → web panel → schedulers → Twitch monitor + EventSub (fire-and-forget, catch-and-log). The DB ping, migrations, guild registry and web listen failures exit 1.

- **`uncaughtException`/`unhandledRejection` log and exit 1**, deliberately: systemd (`Restart=on-failure`) restarts from a clean state. Don't add a handler that swallows and continues. Exit 0 only after a deliberate `shutdown()`. Every exit goes through `exitProcess(code)`, never a bare `process.exit()`, so the logs are flushed first.
- **`shutdown()`** (`SIGINT`/`SIGTERM`) tears everything down inside systemd's `TimeoutStopSec=30`; a teardown still running after `SHUTDOWN_DEADLINE_MS` (25s) exits 1.
- **Single instance only.** Production runs exactly one bot process against the database. The redemption reconciliation cursors, the WebSocket/redemption dedup caches and other in-memory state are per process, the schedulers assume they're the only ticker, and the `redemption_handled` ledger is a check-then-act guard, not a cross-process lock. A change that assumes more than one instance needs a design decision, not a drive-by fix.

## Design Decisions

- **Command matching:** `trigger_string` stores the full prefixed string (e.g. `!clap`). The first word is lowercased and queried directly — **no prefix stripping**.
- **Voice adapter:** `audioPlayer.ts` uses a custom `DiscordGatewayAdapterCreator` via `client.on('raw', ...)`; `guild.voiceAdapterCreator` is unused (discord.js v14 incompatibility).
- **New Command Handler Pattern:** export `registerXRuntime(runtime)` from the handler file to store the platform client, avoiding circular imports with `src/index.ts`. Build the slot with `createRuntimeRegistry()` from `src/shared/runtimeRegistry.ts`, and call it from `index.ts` after the client is ready.

## Tests

Every new function or behaviour change **must** include or update a Vitest test, co-located `*.test.ts` or `src/__tests__/` (match the file being tested). Update affected tests when behaviour changes — never leave a passing-but-wrong test.

## Docstrings

- Every function in source files — exported, internal helpers, inline Express route handlers — **must** have a JSDoc comment saying what it does; one line is enough for simple cases. `eslint-plugin-jsdoc` enforces presence; you own the quality.
- Each parameter gets an `@param` and a function that returns a value gets an `@returns`, each saying what the value is ("Discord snowflake of the guild", not "The guild ID"). No `{type}`. A destructured parameter needs only its root `@param`.
- When you change a function's signature or behaviour, update its JSDoc — stale docs are worse than none.
- Exempt: `*.test.ts` files (helpers and `describe`/`it`/`vi.mock` callbacks) and concise inline callbacks (`.map()` mappers, `Promise` executors, `setTimeout`/`catch` handlers).

## Delegation

Cheaper subagents in `.claude/agents/` take reading-heavy or mechanical work; give them the exact files and findings, and review their diffs:

- `pr-triage` (read-only): every PR activity event, instead of reading CI logs and review comments here.
- `lint-docs-fixer`: ESLint/JSDoc findings spread over several files. Edits only; can't touch config, CI, migrations or crypto, or add `eslint-disable`.
- `coverage-filler`: named uncovered lines. Can only edit `*.test.ts`.
- `acceptance-checker` (read-only): before an issue's PR leaves draft.
- `issue-gardener`: bulk issue labels, Priority, sub-issue links and recheck notes.

**Enforced steps.** `.claude/hooks/workflow-guard.mjs` blocks the main session from skipping three steps. Each step leaves a marker in `.git/claude-workflow/` that covers only the content it checked, so a later change needs the step again. `node .claude/hooks/workflow-state.mjs status` shows which markers are current.

- `git commit`: needs a precommit pass on exactly the working tree being committed (above). Run `git commit` and `git push` each in their own Bash call: the hook sees the state from before the command line runs, so only `cd` and `git add`/`status`/`diff`/`log`/`fetch` may come before them.
- `git push` or opening a PR: when the branch changes `migrations/`, `src/index.ts`, `src/web/middleware.ts`, `src/web/server.ts` or `src/shared/crypto.ts`, consult `advisor` about the change first, then run `node .claude/hooks/workflow-state.mjs record advisor`. Any later change to those files needs a new consult.
- Leaving draft (opening a non-draft PR, or `draft: false`): run `acceptance-checker` against the issue the PR closes (or the PR's stated scope when there is none), then run `node .claude/hooks/workflow-state.mjs record acceptance`. A new commit needs a new check. If the user marks the PR ready themselves, run it when the `ready_for_review` event arrives.

It also blocks resolving review threads: the reviewer (CodeRabbit, Qlty or a person) closes its own after checking the fix (`drive-pr`). The same hook reminds you to dispatch `pr-triage` whenever `ReadNotifications` returns PR activity. Record a marker only after the step really happened: the hooks catch a forgotten step, not a false record. They see only `git` in Bash and the GitHub MCP tools named above: a `gh` command or a commit made inside a script isn't checked, so don't route around them that way. Only the person running the session can turn the hook off, with `CLAUDE_WORKFLOW_GUARD=off` in Claude Code's own environment.

A PreToolUse hook (`.claude/hooks/agent-guard.mjs`) enforces those scopes and stops every subagent changing git state or writing files from Bash; it catches accidents, so diff review still applies. Keep in the main session: `migrations/`, the auth middleware order, `src/shared/crypto.ts` and token handling, and the single-instance assumptions.

**Consult `advisor`** (Opus at high effort in a fresh, read-only context: a second opinion without this session's assumptions, so only here): before splitting a large issue or starting a cross-module feature; when choosing how to split a file Qlty flags for "High total complexity"; before pushing a migration or a change to the auth middleware or startup sequence; after two failed attempts at the same CI failure.

## PR reviews and issues

Qlty's findings are this repo's standards: **never dismiss or resolve one without fixing it**. CodeRabbit's **Merge Risk** must be resolved or explicitly accepted before a PR counts as mergeable. The full rules are in the `drive-pr` skill; the issue rules (severity vs Priority, sub-issues) are in `issue-management`.

## Related repos

`BCUK-Companion-Core`, `BCUK-Companion-ExpiredMinotaur` and `BCUK-StreamDeck-Plugin` follow the same code standards, adapted to their language. Their `CLAUDE.md` files were once synced from this one and are maintained separately now.
