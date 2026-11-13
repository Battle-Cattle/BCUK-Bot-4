# BCUK Bot 4 — Claude Code Instructions

## Node/npm version

`package.json` pins `"engines": { "node": ">=24.22.3" }`, and CI (`.github/workflows/ci.yml`) installs Node `24.x` via `actions/setup-node@v7`, which brings npm 11+. **Always match that before running any `npm` command** — a sandbox's default Node (e.g. the `/opt/node22` on PATH in some environments) ships an older npm whose `npm ci` is stricter about `overrides` bookkeeping than npm 11's and can fail with a spurious `Missing: <pkg>@<version> from lock file` even against a perfectly valid, CI-green lockfile (see the `filing-cabinet`/`typescript` override in `overrides` — this bit us once). If Node 24 isn't already active:

```bash
export NVM_DIR="${NVM_DIR:-/opt/nvm}" && source "$NVM_DIR/nvm.sh"
nvm install 24 && nvm use 24
node -v   # expect 24.x
npm -v    # expect 11.x
```

(If `$NVM_DIR/nvm.sh` doesn't exist in a given sandbox, find whatever installs/switches Node there instead — the point is Node 24.22.3+ / npm 11+, not this exact path.) `.npmrc` sets `engine-strict=true`, so npm refuses to install on an older Node.

`@types/node` stays on the same major as `engines` (Dependabot ignores its major updates), so type-checking rejects APIs newer than the Node the bot runs on. Bump it in the same change that moves `engines` and CI to a new Node major.

In cloud sessions, the "Cloud with Network" environment's setup script has already run `npm ci` under Node 24 (in this repo and in `BCUK-StreamDeck-Plugin`), so `node_modules` is in place. Your shell still starts on the default Node, so switch as above, but skip the install. The repo's own SessionStart hook (`.claude/hooks/session-start.sh`) only runs when the session opens inside this repo, not when several repos are attached.

Do this once per session before `npm install`/`npm ci`/`npm test`/etc. — don't debug an `npm ci` failure by fighting the lockfile before first checking `node -v`/`npm -v`.

## ALWAYS: Before Committing

Run the fast checks on what you changed. CI (`.github/workflows/ci.yml`) runs everything else on every push, so don't repeat its full run locally:

```bash
npm run typecheck
npx vitest run --changed origin/main   # only the tests that import a changed file
npx eslint $(git diff --name-only --diff-filter=d origin/main -- '*.ts' '*.js' '*.mjs' '*.mts')
```

Not `npx tsc`. See "TypeScript 6 + 7" below for why the bare `tsc` command is ambiguous here.

`--changed` follows imports from the changed files, so it misses tests that depend on something indirectly. **Run the full `npm test` instead** when the change touches shared infrastructure: `src/db.ts`, `migrations/` or `DATABASE-SCHEMA.md` (a test replays one against the other), `src/shared/`, `src/test-utils/`, `package.json`/`package-lock.json`, or a `tsconfig*`/`vitest*`/`eslint` config. Leave coverage, `build`, `check:circular`, `check:unused` and `test:toolchain` to CI unless you're changing what they check.

**CI is the gate, not the local run.** A PR isn't done until CI is green. If it fails, reproduce the failing check locally, fix it, and show it passing before pushing again.

## TypeScript 6 + 7

The project is installed with two TypeScript versions side by side:

- **`typescript7`** (`npm:typescript@7.0.2`, the native Go compiler) does all type-checking and building: `npm run typecheck` and `npm run build` (so `deploy.sh` and CI too). About 5× faster than 6.x on this project, with less memory.
- **`typescript`** (6.x) stays the package that tools load as a library: typescript-eslint, eslint-plugin-sonarjs, madge and ts-node (`npm run dev`). TypeScript 7.x no longer exposes the JS compiler API (`require('typescript')` returns only `version`), and these tools still need it — typescript-eslint's peer range is `<6.1.0`, and ts-node crashes on 7.x ([TypeStrong/ts-node#2174](https://github.com/TypeStrong/ts-node/issues/2174)). A nested `overrides` entry can't give them their own copy, because a peer dependency always resolves to the root `typescript`. Dependabot ignores `typescript` major updates for the same reason.

Both packages ship a `tsc` bin and which one npm links depends on how it installed (`npm i` and `npm ci` disagree), so `npx tsc`/`node_modules/.bin/tsc` may be either version. Scripts call the 7.x compiler by path (`node node_modules/typescript7/bin/tsc`); `src/shared/typescriptToolchain.test.ts` holds that in place.

**Moving `typescript` itself to 7.x** once typescript-eslint, sonarjs and madge support it: drop the `typescript7` alias, point the scripts back at plain `tsc`, remove the Dependabot ignore, and keep ts-node working by adding `@typescript/typescript6` (the TypeScript team's package of the 6.x API) and running it with `TS_NODE_COMPILER=@typescript/typescript6` in `dev` and `register({ compiler: require.resolve('@typescript/typescript6') })` in the toolchain test (`require.resolve` is also what lets knip see the package as used) — or replace ts-node.

---

## Dev

```bash
npm run dev             # ts-node src/index.ts
npm test                # Vitest (everything except the ts-node toolchain smoke test)
npm run test:toolchain  # ts-node smoke test only — slow (type-checks the project); CI runs it
```

Vitest keeps an on-disk transform cache in `.vitest-cache/` (gitignored, outside `node_modules` so it survives `npm ci`); `deploy.sh` and CI drop/re-key it when `package-lock.json` changes. If a run ever looks stale, `rm -rf .vitest-cache`. In tests, prefer `waitFor` from `src/test-utils/waitFor.ts` over `vi.waitFor` (1ms poll instead of 50ms).
Tests run in Vitest's `vmThreads` pool (each file gets a fresh VM context on a reused worker thread; ~2x faster than `forks`). Module isolation between files is unchanged, but objects created by Node built-ins come from a different realm, so assert on `.name`/`.code` rather than `instanceof` against a Node built-in class.

---

## Directory Structure

- **`src/index.ts`** — entry point (see Startup Sequence below).
- **`src/db.ts` + `src/db/`** — DB facade + one module per domain (`users.ts`, `guilds.ts`, `customCommands.ts`, `counters.ts`, `sfx.ts`, `streamMonitor.ts`, `eventSub.ts`, etc.), each with a co-located `*.test.ts`. Writes to cached tables get a cache-invalidating `*Writes.ts` wrapper module (`userWrites.ts`, `customCommandWrites.ts`, `counterWrites.ts`, `sfxWrites.ts`, etc., built on `withInvalidation.ts`) that `db.ts` re-exports in place of the raw write. `db.ts` itself is pure re-exports. Import from `src/db.ts` only (see Critical Invariants).
- **`src/discord/`** — Discord bot bootstrap, guild registry, voice presence.
- **`src/twitch/`** — Twitch chat bot + Helix API client, with `eventsub/`, `monitor/`, `pricing/`, `timers/` subfolders.
- **`src/commands/`** — command routing/cooldowns/handlers shared by both platforms.
- **`src/audio/`** — voice playback and SFX (see Voice adapter design decision below).
- **`src/web/`** — Express app (`server.ts`) + route/controller files under `web/routes/` (see Web Server below).
- **`src/shared/`** — cross-cutting utilities: `config.ts` (env vars), `logger.ts`, `crypto.ts`, `mutationQueue.ts`, `userMutationQueue.ts` (per-user write serialisation), `runtimeRegistry.ts` (runtime-injection slots), `statusStore.ts`, `textTemplate.ts`.
- **`src/types/`** — Express `Request`/session type augmentation.
- **`src/test-utils/`** — shared test fixtures/mocks.

---

## Tech Stack

- **Runtime:** discord.js v14, `@twurple/chat` + `@twurple/auth` (Twitch chat), `mediaplex` (Opus), express v5 + `express-session`/`express-mysql-session`, `mysql2`, `helmet`, `winston`.
- **TypeScript:** `strict: true` plus `noUncheckedIndexedAccess` (so `rows[0]` is `T | undefined` — guard it, or use `!` only where a nearby check guarantees it, with a comment saying which), target ES2024, `moduleResolution: NodeNext`. `package.json` pins `"engines": { "node": ">=24.22.3" }` — see Node/npm version above.
- **ESLint** (flat config, type-aware): `no-floating-promises`, `no-misused-promises`, and `no-console` are all **errors**, not warnings — these affect how code must be written (await/void everything, use `logger` not `console.*`). `no-explicit-any` is a warning; relaxed for `*.test.ts`. `eslint-plugin-jsdoc` enforces the Docstrings rule below (`require-jsdoc` on function declarations, methods and module-level arrow functions, in `src/` and the `public/` browser scripts alike; `require-param`/`require-returns`, with descriptions, for what each documented function takes and returns; `check-param-names` catches stale `@param`s), `eslint-plugin-sonarjs` adds complexity checks on source files (`sonarjs/cognitive-complexity` ≤ 15, the same metric as Qlty's function-complexity smell, plus cyclomatic `complexity` ≤ 12, `max-params` 5, `max-depth` 3, `max-nested-callbacks` 3, all errors), and `@vitest/eslint-plugin` guards tests (no `.only`/`.skip`, no assertion-free tests). The browser scripts in `public/` (classic `<script>`s, no bundler) are linted too, with browser globals: a name a script uses from another script on the same page goes in a `/* global name */` header at its top (`name:writable` if it assigns to it).
- **Test/build scripts:** `npm run build` (`tsc -p tsconfig.build.json`, on TypeScript 7), `npm run typecheck` (`tsc --noEmit`, the whole project including tests, on TypeScript 7), `npm run lint`, `npm run check:circular` (madge), `npm run check:unused` (knip: unused files, exports and dependencies; `knip.json`). An export used only in its own file is fine; an alias of another export needs an `@alias` JSDoc tag.

---

## Startup Sequence (`src/index.ts`)

Boot order in `main()`: verify DB connectivity (ping, exit 1 on failure) → apply pending schema migrations (exit 1 on failure) → re-encrypt stored OAuth tokens under the active `EVENTSUB_TOKEN_SECRET` (`reencryptStoredTokens`; catch-and-log only, see the README's "Rotating EVENTSUB_TOKEN_SECRET") → wire Twitch/EventSub runtime callbacks → `reloadGuildRegistry()` (must complete before Discord connects, exit 1 on failure) → start Discord bot → start Twitch bot → start web panel (a listen failure such as `EADDRINUSE` exits 1 — most likely an old process still running) → start schedulers (counter/reward-pricing/timer) → start Twitch monitor + EventSub (fire-and-forget, catch-and-log only, doesn't crash the process).

- **`uncaughtException`/`unhandledRejection`** both log and `process.exit(1)` — deliberate: the app fails loudly instead of limping on with a corrupted state, and production's systemd unit (`deploy/bcuk-bot.service`, `Restart=on-failure`) brings it back up from a clean start. Exit 1 for fatal errors and 0 only after a deliberate `shutdown()`, so systemd can tell them apart. Don't add a handler that swallows and continues.
- **`GET /healthz`** (`src/web/server.ts`) answers once the web panel is listening, which `main()` reaches only after the DB ping, guild registry and bot startup. `deploy.sh` polls it after restarting the service, then checks the bot stays up for 30s; if either fails it rolls back to the previous build (see the README's "Deployment"). Keep it unauthenticated, ahead of the session and rate-limit middleware, and free of any detail beyond "ok".
- **`shutdown()`** runs on `SIGINT`/`SIGTERM`: closes the web panel (dropping open SSE connections), stops schedulers/EventSub/monitor/bots, disconnects audio, closes the DB pool, then exits 0.
- **Single instance only.** Production runs exactly one bot process against the database. Several subsystems rely on that: the redemption reconciliation cursors (`twitchEventSubReconciliationCursors.ts`) and the WebSocket/redemption dedup caches are in-memory per process, the schedulers (counter/reward-pricing/timer) assume they're the only ticker, and the `redemption_handled` ledger is a check-then-act guard, not a cross-process lock. Don't design for horizontal scaling without first revisiting those; a change that assumes more than one instance needs a design decision, not a drive-by fix.

---

## Web Server (`src/web/server.ts`)

Middleware order: `helmet` (custom CSP) → `GET /healthz` → EJS views → static → body parsers → `trust proxy: 1` → `preSessionLimiter` (coarse per-IP cap, so a replayed session cookie can't hit the session store unthrottled) → session (`express-mysql-session`, backed by the `sessions` MySQL table, on its own bounded pool from `getSessionPool`; a full queue answers 503) → rate limiters (general/session; `streamdeckLimiter` is applied per-route instead) → `res.locals.user`/csrfToken → feature routes (`mountRoutes` in `src/web/routes/index.ts`, which keeps their mount order) → 404 and error handlers. The general/session rate limiters run after session middleware deliberately — `sessionLimiter`'s key generator needs `req.session` populated.

Auth middleware (`src/web/middleware.ts`), applied in this order:
1. **`requireAuth`** — session check.
2. **`requireGuildContext`** — re-derives the user's access level from the DB for the active guild on every request. **Must run before any `requireAccessLevel` check** — skipping it leaves a stale or absent access level that could bypass a mod/manager/admin gate.
3. **`requireAccessLevel(level)`** factory → `requireMod`/`requireManager`/`requireAdmin`.
4. **`requireOwner`** — separate global super-admin check via `is_owner`, not part of the `AccessLevel` ladder.
5. **`authenticateBearerToken()`** factory → `requireApiKey` (Streamdeck) / `requireCompanionKey` (companion app), for API routes that bypass session auth entirely.

---

## Critical Invariants

- **`mediaplex` must be the first import in `src/index.ts`** — registers the Opus provider. Never reorder.
- **Import DB functions from `src/db.ts` only**, never `src/db/*` directly. The facade re-exports some writes from the cache-invalidating `src/db/*Writes.ts` wrappers (`upsertUser`, `updateTwitchBotEnabled`, …) instead of the raw DB modules; `src/db.test.ts` checks that every wrapper is the one exported.
- **BIGINT columns are strings** (`bigNumberStrings: true` on the pool) — never coerce to `Number`. This protects against precision loss on values that can exceed `Number.MAX_SAFE_INTEGER`, like Discord snowflakes — it does not apply to a BIGINT result you can prove is bounded well within that range (e.g. `COUNT(*)` on a small admin table). If you do parse one of those back to a number, say so at the call site (why this particular value is bounded) — don't let it read like the same blind coercion the rule forbids elsewhere. See `getRowCount` in `src/db/utils.ts` for the pattern.
- **Blank Twitch names → `NULL`** — `user.twitch_name` has a unique index; empty strings collide.
- **`mutationQueue`** for concurrent-unsafe DB writes — user mutations serialise through it via `runUserMutation` in `src/shared/userMutationQueue.ts`.
- **POST routes redirect to `?error=code`** on failure; GET reads it and passes to EJS. Never render errors from a POST handler.
- **`src/discord/discordUtils.ts`** has `isDiscordNotFoundError` and `tryDeleteDiscordMessage` — import, don't duplicate.

---

## Access Levels

0=User, 1=Mod (+voice), 2=Manager (+user list, streams/commands/counters/SFX), 3=Admin (full). Use `AccessLevel` const from `src/db/users.ts` — not raw numbers. Manager+ = ≥ 2.

**Custom Commands exception:** any user with a linked Twitch account can manage the commands on their own channel. They can add Twitch-only commands, edit/delete commands assigned to them alone, and remove themselves from shared ones. Mod+ manage the whole catalog: Discord/multi-Twitch flags, assignments and server overrides. The rules live in `src/web/routes/commandPermissions.ts`; the Mod+ catalog check, assignee lookup and new-entry assignee rule shared with Timers live in `src/web/routes/selfServiceAccess.ts`.

**Timers exception:** the same self-service model applies to Timers. A user with a linked Twitch account can add timers to their own channel, edit/toggle/delete timers assigned to them alone, and remove themselves from shared ones. Mod+ manage the whole catalog and its assignments. The rules live in `src/web/routes/timerPermissions.ts` (plus the shared `selfServiceAccess.ts`), and streamer writes go through the owner-checked `*OwnTimerCommand*` DB functions.

**Advanced Commands:** per-streamer and self-service only — no catalog, assignments or Mod+ override. Every route resolves the session user's (or the Stream Deck/companion key owner's) streamer record, and every DB function is scoped by `streamer_id`. The DB layer is `src/db/advancedCommand*.ts`, the runtime (gates, effects, companion acknowledgements and refunds) is `src/commands/advancedCommands/`, and the use ledger `advanced_command_usage` makes a refund happen at most once.

---

## Design Decisions

**Command matching:** `trigger_string` stores the full prefixed string (e.g. `!clap`). First word is lowercased and queried directly — **no prefix stripping**.

**Lightweight Discord imports:** loading `discord.js` costs ~300ms per test file, so modules that only need a few runtime values take them from the packages discord.js re-exports instead (direct dependencies, kept at the versions discord.js uses): `discord-api-types/v10` (`ChannelType`, `Routes`, `RESTJSONErrorCodes`), `@discordjs/rest` (`DiscordAPIError`, `HTTPError`, `makeURLSearchParams`), `@discordjs/builders` (`EmbedBuilder`), `@discordjs/formatters` (`escapeMarkdown`). Types-only uses are `import type { … } from 'discord.js'`. Only code that constructs the client itself (`discordBot.ts`) imports `discord.js` at runtime; `audioPlayer.ts` is handed the client and only needs its types.

**Voice adapter:** `audioPlayer.ts` uses a custom `DiscordGatewayAdapterCreator` via `client.on('raw', ...)`. `guild.voiceAdapterCreator` is unused — discord.js v14 incompatibility.

**`customCommands.ts` does not own its cache:** it's a pure DB layer with no cache knowledge, to break its import cycle with `customCommandCache.ts`. `customCommandWrites.ts` owns invalidation instead (re-exported by `db.ts`), via `withInvalidation()`-wrapped write functions that call `invalidateCustomCommandLookupCache()` after the underlying `customCommands.ts` write succeeds (same pattern used for `counters.ts`/`alertConfig.ts`/`sfx.ts` via `counterWrites.ts`/`alertConfigWrites.ts`/`sfxWrites.ts`). Don't add a second invalidation call inside `customCommands.ts` itself.

**MySQL 8 upsert:** Row-alias form only: `VALUES (...) AS new_row`. Deprecated `VALUES(col)` not used.

**Migrations:** the bot applies pending `migrations/NNNN_*.sql` files on startup (`src/db/migrations.ts`, tracked in `schema_migrations`; see the README's "Database migrations"). `0001_baseline.sql` is the full schema at the switch. Any schema change is a new numbered file plus a matching `DATABASE-SCHEMA.md` update (a test replays the migrations against the doc). Never edit an applied migration — startup fails on a checksum mismatch. A deploy that brings new migrations and then fails its health check doesn't roll back automatically (the previous build refuses to start against a migration it has no file for, and a migration that failed part way leaves unrecorded DDL behind), so `deploy.sh` stops and prints the manual steps, starting with the database backup it takes before every restart (`scripts/backup-db.sh`).

**Docs:** `DATABASE-SCHEMA.md` is the schema reference. `.devin/wiki.json` is a purpose-only architecture outline (no full prose) — useful as a map before diving into source, not a substitute for reading it.

---

## Tests

- Every new function or behaviour change **must** include or update a Vitest test in the relevant `*.test.ts` file alongside the source file.
- Tests live in `src/__tests__/` or co-located `*.test.ts` files — match the convention of the file being tested.
- When modifying existing behaviour, update affected tests before committing — never leave a passing-but-wrong test.
- Run the tests for what you changed before committing (see "ALWAYS: Before Committing" for when that means the full suite), and make sure CI's full run passes.

---

## Docstrings

- All functions — including exported functions, internal helpers, and anonymous functions (e.g. inline Express route handlers) — **must** have a JSDoc comment describing what they do, their parameters, and return value — one line is enough for simple cases.
- Each parameter gets an `@param` and a function that returns a value gets an `@returns`, each with a description (e.g. `@param guildId - Discord snowflake of the guild.`). No `{type}` in TypeScript; the signature has it. Say what the value is, not just its name: "Discord snowflake of the guild", not "The guild ID." A destructured parameter needs only its root `@param`.
- When you change a function's signature or behaviour, update its JSDoc to match — stale docs are worse than no docs.
- **Test files (`*.test.ts`) are exempt.** Test-local helpers (mock builders like `mockLog`/`mockRes`, response/fixture factories, etc.) and `describe`/`it`/`vi.mock` callbacks don't need JSDoc — a descriptive `it('...')` name documents the behaviour instead. This applies only inside `*.test.ts` files; source files still follow the rule above.
- **Concise inline callbacks** (e.g. `.map()` row mappers, a `Promise` executor, a `setTimeout` callback, a `catch` handler) don't need a separate JSDoc block. Add a short inline comment only when the behaviour isn't obvious from the code itself.

---

## New Command Handler Pattern

Export `registerXRuntime(runtime)` from the handler file to store the platform client — avoids circular imports with `src/index.ts`. Build the slot with `createRuntimeRegistry()` from `src/shared/runtimeRegistry.ts`. Call it from `index.ts` after the client is ready.

---

## GitHub Issues

Every issue has two independent ratings:

- **Severity = impact**: how much it matters if it's never done (or how bad the bug is). It's a label: `severity:critical`/`severity:high`/`severity:medium`/`severity:low`. Titles don't need a severity prefix. Add a type label too (`bug`, `enhancement`, `documentation`, `security`, …).
- **Priority = urgency**: how soon it should be done. It's the org-level **Priority** issue field (`Urgent`/`High`/`Medium`/`Low`), not a label or title prefix. Every open issue has one.

The two can differ (e.g. a low-impact fix that's wanted soon, or a high-impact feature that can wait). Don't "correct" one to match the other.

**Large issues are split into sub-issues**, linked as real GitHub sub-issues (not just mentioned in the body):

- Title: `<parent topic> n/N: <what this part does>`, e.g. `Faster test suite 2/4: sub-second, configurable polling in deploy.sh`. Mark optional parts `(optional)`.
- Body: which parent it's part of and which step of the parent's plan it covers, its scope, tests, and a "Depends on" list of the other parts it needs. The full design stays in the parent.
- **Priority matches the parent.** Change the parent's and every open sub-issue's together.
- **Severity is the same as the parent's or lower**, judged on what that part delivers on its own (e.g. a read-only page that's empty until a later part lands is lower than the parts that deliver the feature). **The parent's severity is the highest of its sub-issues'**: when a sub-issue's severity changes, recheck the parent's.
- Closing the last open sub-issue completes the parent. Close a part that turned out not to be needed as "not planned", with a note on the parent.

**Keeping issues up to date:** an issue says which commit it was checked against (``checked against `main` @ `<sha>` ``). When you recheck one, add a dated note with the new sha rather than silently rewriting it. Mark finished items as done (strike through or tick them, saying when and in which PR) instead of deleting them. When an issue's premise has changed (e.g. the code it describes was rewritten), re-scope it and keep the original description in a collapsed `<details>` block at the bottom. Before starting on an issue, check its file paths, line counts and defaults against current `main`.

---

## Related repos

`BCUK-Companion-Core`, `BCUK-Companion-ExpiredMinotaur` and `BCUK-StreamDeck-Plugin` follow the same code standards, adapted to their language: tests with every change, docstrings on every function, Qlty's complexity limits, and fast checks on what changed before committing, with CI's full run as the gate. The plugin's `eslint.config.js` is a port of this repo's; the .NET repos enforce docs with StyleCop's SA1600 rules. Their `CLAUDE.md` files carry the same "PR Reviews (Qlty)" and "PR Reviews (CodeRabbit)" sections, word for word. When you change a shared rule here, make the same change in those three files.

## PR Reviews (Qlty)

Qlty's PR comments (code smells such as file/function complexity, too many returns, duplication, plus diff-coverage gaps) are this repo's standards, not optional suggestions. **Never dismiss, defer or resolve a Qlty finding without fixing it**, and never reply that it "stays as is" or belongs in a follow-up. Fix every finding in the same PR, whether it's an inline review comment or a row in the "new issues" or coverage summary:
- **Complexity, returns or structure:** refactor (extract helpers or a module) until the metric is under the threshold, keeping behaviour unchanged and tests green.
- **Uncovered new lines:** add tests that cover them.

After pushing, check that Qlty's next analysis no longer lists the finding.

## PR Reviews (CodeRabbit)

CodeRabbit reviews each push to a non-draft PR (marking a draft ready triggers one by itself). It's rate-limited per developer and **never retries on its own**. Only when a comment says "Review limit reached" with a wait time: wait that long, then post exactly one `@coderabbitai review` (only what changed since the last review), or `@coderabbitai full review` when the last Merge Risk was 🟡 Moderate or higher or the changes since are large. Any other "skipped" reason (draft, no new commits) needs no action.

**Merge Risk:** after every review, read the **Merge Risk** line in CodeRabbit's "📝 Walkthrough" comment, which is rewritten in place each time, not just the inline comments. A caveat under it is a real concern even at 🔵 Low: fix it, or post one PR comment saying why it's acceptable, before treating the PR as mergeable. After pushing a fix, say what the risk was and which commit fixes it in a comment tagging `@coderabbitai`; if the risk was 🟡 Moderate or higher, the re-review must be a `@coderabbitai full review`. Repeat until a review comes back with the risk resolved or explicitly accepted. [BCUK-Bot-4 PR #612](https://github.com/Battle-Cattle/BCUK-Bot-4/pull/612) shows the full pattern. This applies to any PR you're driving to green.

**Don't thrash:** never push while a review is in progress (it fails with "head commit changed"), and never re-trigger while rate-limited or in progress. A rate-limit reply only reports the remaining cooldown.
