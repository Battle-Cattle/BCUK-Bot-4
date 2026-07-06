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

## Critical Invariants

- **`mediaplex` must be the first import in `src/index.ts`** — registers the Opus provider. Never reorder.
- **Import DB functions from `src/db.ts` only**, never `src/db/*` directly. The facade wraps some functions with cache-invalidation side effects (`upsertUser`, `removeUser`, `updateTwitchBotEnabled`).
- **BIGINT columns are strings** (`bigNumberStrings: true` on the pool) — never coerce to `Number`.
- **Blank Twitch names → `NULL`** — `user.twitch_name` has a unique index; empty strings collide.
- **`mutationQueue`** for concurrent-unsafe DB writes — user mutations serialise through it.
- **POST routes redirect to `?error=code`** on failure; GET reads it and passes to EJS. Never render errors from a POST handler.
- **`src/discordUtils.ts`** has `isDiscordNotFoundError` and `tryDeleteDiscordMessage` — import, don't duplicate.

---

## Access Levels

0=User, 1=Mod (+voice), 2=Manager (+user list, streams/commands/counters/SFX), 3=Admin (full). Use `AccessLevel` const from `src/db/users.ts` — not raw numbers. Manager+ = ≥ 2.

---

## Design Decisions

**Command matching:** `trigger_string` stores the full prefixed string (e.g. `!clap`). First word is lowercased and queried directly — **no prefix stripping**.

**Voice adapter:** `audioPlayer.ts` uses a custom `DiscordGatewayAdapterCreator` via `client.on('raw', ...)`. `guild.voiceAdapterCreator` is unused — discord.js v14 incompatibility.

**`customCommands.ts` owns its cache:** Write functions call `invalidateCustomCommandLookupCache()` internally — don't add a second call in `db.ts`.

**MySQL 8 upsert:** Row-alias form only: `VALUES (...) AS new_row`. Deprecated `VALUES(col)` not used.

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

---

## New Command Handler Pattern

Export `registerXRuntime(runtime)` from the handler file to store the platform client — avoids circular imports with `src/index.ts`. Call it from `index.ts` after the client is ready. Record matches via `commandMonitorStore`.

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
