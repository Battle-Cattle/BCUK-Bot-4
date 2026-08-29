# BCUK Bot 4 — Claude Code Instructions

## ALWAYS: Before Committing

```bash
npx tsc --noEmit && npm test
```

---

## Dev

```bash
npm run dev   # ts-node src/index.ts
npm test      # Vitest
```

---

## Directory Structure

- **`src/index.ts`** — entry point (see Startup Sequence below).
- **`src/db.ts` + `src/db/`** — DB facade + one module per domain (`users.ts`, `guilds.ts`, `customCommands.ts`, `counters.ts`, `sfx.ts`, `streamMonitor.ts`, `eventSub.ts`, etc.), each with a co-located `*.test.ts`. Import from `src/db.ts` only (see Critical Invariants).
- **`src/discord/`** — Discord bot bootstrap, guild registry, voice presence.
- **`src/twitch/`** — Twitch chat bot + Helix API client, with `eventsub/`, `monitor/`, `pricing/`, `timers/` subfolders.
- **`src/commands/`** — command routing/cooldowns/handlers shared by both platforms.
- **`src/audio/`** — voice playback and SFX (see Voice adapter design decision below).
- **`src/web/`** — Express app (`server.ts`) + route/controller files under `web/routes/` (see Web Server below).
- **`src/shared/`** — cross-cutting utilities: `config.ts` (env vars), `logger.ts`, `crypto.ts`, `mutationQueue.ts`, `statusStore.ts`, `textTemplate.ts`.
- **`src/types/`** — Express `Request`/session type augmentation.
- **`src/test-utils/`** — shared test fixtures/mocks.

---

## Tech Stack

- **Runtime:** discord.js v14, tmi.js (Twitch chat), `mediaplex` (Opus), express v5 + `express-session`/`express-mysql-session`, `mysql2`, `helmet`, `winston`.
- **TypeScript:** `strict: true`, target ES2024, `moduleResolution: NodeNext`. No `engines` field in `package.json`.
- **ESLint** (flat config, type-aware): `no-floating-promises`, `no-misused-promises`, and `no-console` are all **errors**, not warnings — these affect how code must be written (await/void everything, use `logger` not `console.*`). `no-explicit-any` is a warning; relaxed for `*.test.ts`.
- **Test/build scripts:** `npm run build` (`tsc -p tsconfig.build.json`), `npm run lint`, `npm run check:circular` (madge).

---

## Startup Sequence (`src/index.ts`)

Boot order in `main()`: verify DB connectivity (ping, exit 1 on failure) → wire Twitch/EventSub runtime callbacks → `reloadGuildRegistry()` (must complete before Discord connects, exit 1 on failure) → start Discord bot → start Twitch bot → start web panel → start schedulers (counter/reward-pricing/timer) → start Twitch monitor + EventSub (fire-and-forget, catch-and-log only, doesn't crash the process).

- **`uncaughtException`/`unhandledRejection`** both log and `process.exit(1)` — deliberate: there's no process supervisor, so the app fails loudly instead of limping on with a corrupted state. Don't add a handler that swallows and continues.
- **`shutdown()`** runs on `SIGINT`/`SIGTERM`: stops schedulers/EventSub/monitor/bots, disconnects audio, closes the DB pool, then exits 0.

---

## Web Server (`src/web/server.ts`)

Middleware order: `helmet` (custom CSP) → EJS views → static → body parsers → `trust proxy: 1` → session (`express-mysql-session`, backed by the `sessions` MySQL table) → rate limiters (general/session; `streamdeckLimiter` is applied per-route instead) → `res.locals.user`/csrfToken. The general/session rate limiters run after session middleware deliberately — `sessionLimiter`'s key generator needs `req.session` populated.

Auth middleware (`src/web/middleware.ts`), applied in this order:
1. **`requireAuth`** — session check.
2. **`requireGuildContext`** — re-derives the user's access level from the DB for the active guild on every request. **Must run before any `requireAccessLevel` check** — skipping it leaves a stale or absent access level that could bypass a mod/manager/admin gate.
3. **`requireAccessLevel(level)`** factory → `requireMod`/`requireManager`/`requireAdmin`.
4. **`requireOwner`** — separate global super-admin check via `is_owner`, not part of the `AccessLevel` ladder.
5. **`authenticateBearerToken()`** factory → `requireApiKey` (Streamdeck) / `requireCompanionKey` (companion app), for API routes that bypass session auth entirely.

---

## Critical Invariants

- **`mediaplex` must be the first import in `src/index.ts`** — registers the Opus provider. Never reorder.
- **Import DB functions from `src/db.ts` only**, never `src/db/*` directly. The facade wraps some functions with cache-invalidation side effects (`upsertUser`, `updateTwitchBotEnabled`).
- **BIGINT columns are strings** (`bigNumberStrings: true` on the pool) — never coerce to `Number`. This protects against precision loss on values that can exceed `Number.MAX_SAFE_INTEGER`, like Discord snowflakes — it does not apply to a BIGINT result you can prove is bounded well within that range (e.g. `COUNT(*)` on a small admin table). If you do parse one of those back to a number, say so at the call site (why this particular value is bounded) — don't let it read like the same blind coercion the rule forbids elsewhere. See `getRowCount` in `src/db/utils.ts` for the pattern.
- **Blank Twitch names → `NULL`** — `user.twitch_name` has a unique index; empty strings collide.
- **`mutationQueue`** for concurrent-unsafe DB writes — user mutations serialise through it.
- **POST routes redirect to `?error=code`** on failure; GET reads it and passes to EJS. Never render errors from a POST handler.
- **`src/discord/discordUtils.ts`** has `isDiscordNotFoundError` and `tryDeleteDiscordMessage` — import, don't duplicate.

---

## Access Levels

0=User, 1=Mod (+voice), 2=Manager (+user list, streams/commands/counters/SFX), 3=Admin (full). Use `AccessLevel` const from `src/db/users.ts` — not raw numbers. Manager+ = ≥ 2.

---

## Design Decisions

**Command matching:** `trigger_string` stores the full prefixed string (e.g. `!clap`). First word is lowercased and queried directly — **no prefix stripping**.

**Voice adapter:** `audioPlayer.ts` uses a custom `DiscordGatewayAdapterCreator` via `client.on('raw', ...)`. `guild.voiceAdapterCreator` is unused — discord.js v14 incompatibility.

**`customCommands.ts` does not own its cache:** it's a pure DB layer with no cache knowledge, to break its import cycle with `customCommandCache.ts`. `db.ts` owns invalidation instead, via `withInvalidation()`-wrapped write functions that call `invalidateCustomCommandLookupCache()` after the underlying `customCommands.ts` write succeeds (same pattern used for `counters.ts`/`alertConfig.ts`/`sfx.ts`). Don't add a second invalidation call inside `customCommands.ts` itself.

**MySQL 8 upsert:** Row-alias form only: `VALUES (...) AS new_row`. Deprecated `VALUES(col)` not used.

**Docs:** `DATABASE-SCHEMA.md` is the schema reference — the DB is managed outside this repo, don't infer schema from migrations. `.devin/wiki.json` is a purpose-only architecture outline (no full prose) — useful as a map before diving into source, not a substitute for reading it.

---

## Tests

- Every new function or behaviour change **must** include or update a Vitest test in the relevant `*.test.ts` file alongside the source file.
- Tests live in `src/__tests__/` or co-located `*.test.ts` files — match the convention of the file being tested.
- When modifying existing behaviour, update affected tests before committing — never leave a passing-but-wrong test.
- Run `npm test` and confirm all tests pass before committing.

---

## Docstrings

- All functions — including exported functions, internal helpers, and anonymous functions (e.g. inline Express route handlers) — **must** have a JSDoc comment describing what they do, their parameters, and return value — one line is enough for simple cases.
- When you change a function's signature or behaviour, update its JSDoc to match — stale docs are worse than no docs.
- **Test files (`*.test.ts`) are exempt.** Test-local helpers (mock builders like `mockLog`/`mockRes`, response/fixture factories, etc.) and `describe`/`it`/`vi.mock` callbacks don't need JSDoc — a descriptive `it('...')` name documents the behaviour instead. This applies only inside `*.test.ts` files; source files still follow the rule above.
- **Concise inline callbacks** (e.g. `.map()` row mappers, a `Promise` executor, a `setTimeout` callback, a `catch` handler) don't need a separate JSDoc block. Add a short inline comment only when the behaviour isn't obvious from the code itself.

---

## New Command Handler Pattern

Export `registerXRuntime(runtime)` from the handler file to store the platform client — avoids circular imports with `src/index.ts`. Call it from `index.ts` after the client is ready.

---

## PR Reviews (CodeRabbit)

CodeRabbit auto-reviews pushes but is rate-limited per developer; a rate-limited push gets a "Review limit reached" comment with a wait time and no actual diff review. **It never auto-retries** once the cooldown passes — a manual trigger is required every time, even if you just wait it out. After the wait time shown in the rate-limit comment has elapsed, post a PR comment:

- **`@coderabbitai review`** — reviews only what changed since the last review. Default choice.
- **`@coderabbitai full review`** — re-reviews the entire PR from scratch. Use this instead when the last review surfaced a lot of issues, or the intervening changes are large.

**The manual comment is ONLY for the rate-limit case above.** Do not post it reactively for other "review skipped" reasons:
- **"Review skipped: Draft detected"** — expected while the PR is a draft. Marking the PR ready for review (`draft: false`) auto-triggers a review on its own; no comment needed. Only manually trigger if, after going ready, no review shows up within a few minutes.
- **"No new commits to review since the last review"** — CodeRabbit is up to date; nothing to do.

If unsure which case a "skipped"/"no review" comment falls into, check whether it names a wait time (rate-limit → wait then trigger) or a different reason (draft/no-new-commits → no action).

**Avoid re-triggering thrash:**
- **Never push a new commit while a review is in progress** — the in-flight review fails outright ("head commit changed during the review") and wastes the attempt. Wait for the review to finish (or fail/rate-limit) before pushing again.
- **Never re-trigger `@coderabbitai review` while already rate-limited or still in progress.** Each rate-limit reply just reports the currently remaining cooldown (it doesn't reset or extend it) — retrying early is simply wasted, not counterproductive. Wait out the countdown, trigger exactly once, then leave it alone until it either posts real findings or rate-limits again.
