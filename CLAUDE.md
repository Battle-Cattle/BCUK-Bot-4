# BCUK Bot 4 — Claude Code Instructions

## ALWAYS: Codebase Questions → Use Graphify First

```bash
graphify query "<question>"
graphify path "<A>" "<B>"
graphify explain "<concept>"
```

Use `graphify-out/GRAPH_REPORT.md` for broad architecture review. After changing code run `graphify update .`.

---

## ALWAYS: Before Committing

```bash
npx tsc --noEmit && npm test
```

`qlty check` runs automatically on staged files — **commits are blocked if it finds issues**. Never `--no-verify`.

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
- **`boolFromDb()` from `src/db/utils.ts`** for all tinyint/bit columns — MySQL may return a `Buffer`.
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

**Command matching:** `trigger_command` stores the full prefixed string (e.g. `!clap`). First word is lowercased and queried directly — **no prefix stripping**.

**Voice adapter:** `audioPlayer.ts` uses a custom `DiscordGatewayAdapterCreator` via `client.on('raw', ...)`. `guild.voiceAdapterCreator` is unused — discord.js v14 incompatibility.

**Shadow mode:** `CUSTOM_COMMANDS_LIVE_REPLIES=true` enables live replies; `COUNTER_LIVE_WRITES=true` enables counter increments. Both default `false`.

**`customCommands.ts` owns its cache:** Write functions call `invalidateLookupCache()` internally — don't add a second call in `db.ts`.

**MySQL 8 upsert:** Row-alias form only: `VALUES (...) AS new_row`. Deprecated `VALUES(col)` not used.

---

## New Command Handler Pattern

Export `registerXRuntime(runtime)` from the handler file to store the platform client — avoids circular imports with `src/index.ts`. Call it from `index.ts` after the client is ready. Record matches via `commandMonitorStore`.
