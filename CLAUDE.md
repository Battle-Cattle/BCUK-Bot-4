# BCUK Bot 4 — Claude Code Instructions

Multi-platform community bot (Twitch, Discord, TikTok) with web control panel. TypeScript + Node.js (CommonJS), discord.js v14, tmi.js, mysql2, Express + EJS.

---

## ALWAYS: Codebase Questions → Use Graphify First

This project has a knowledge graph at `graphify-out/`. Query it before browsing source files:

```bash
graphify query "<question>"     # general questions
graphify path "<A>" "<B>"       # relationship between files/modules
graphify explain "<concept>"    # focused concept
```

Use `graphify-out/wiki/index.md` for broad navigation. Read `graphify-out/GRAPH_REPORT.md` only for architecture review or when the above commands don't surface enough context. After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

---

## ALWAYS: Verify Changes Before Committing

```bash
npx tsc --noEmit   # must produce no output
npm test           # all Vitest tests must pass
```

A pre-commit hook (`.claude/hooks/pre-commit-quality-check.sh`) **automatically runs `qlty check` on staged files before every commit**. If qlty finds issues the commit is blocked — fix the reported findings before retrying. Never use `--no-verify`. In cloud sessions, qlty is installed by `.claude/hooks/session-start.sh`.

---

## Dev Commands

```bash
npm run dev    # ts-node src/index.ts (development)
npm run build  # tsc → dist/  (uses tsconfig.build.json, excludes tests)
npm start      # node dist/index.js (production)
npm test       # run tests once
npm run test:watch  # re-run on change
```

Node.js **22.x** required (`nvm use 22`). No ESLint/Prettier — don't run them. DB migrations in `migrations/` are applied manually against MySQL. Full schema: `DATABASE-SCHEMA.md`.

---

## Critical Invariants

Violating these causes silent bugs:

- **`mediaplex` must be the very first import in `src/index.ts`** — registers the Opus provider before any other module loads. Never reorder it.
- **Always import DB functions from `src/db.ts`**, never from `src/db/*` directly. `db.ts` is the public facade and wraps some functions with cache-invalidation side effects (e.g. `upsertUser`, `removeUser`, `updateTwitchBotEnabled`).
- **Use `boolFromDb()` from `src/db/utils.ts`** for all tinyint/bit columns — MySQL may return them as a single-byte `Buffer`, not `0`/`1`.
- **Never coerce BIGINT columns to `Number`** — the pool returns them as strings (`bigNumberStrings: true`). Discord IDs exceed JS safe integer range.
- **Blank Twitch names → `NULL`** — `user.twitch_name` has a unique index; empty strings would collide across multiple users with no Twitch channel.
- **Use `mutationQueue`** for concurrent-unsafe DB writes. Admin user mutations (`upsertUser`, `removeUser`, `updateAccessLevel`, `updateTwitchBotEnabled`) serialise through it to prevent races.
- **POST routes redirect, never render errors inline** — on failure redirect to `?error=code`; the GET handler reads it and passes it to the EJS template.

---

## Architecture

`src/index.ts` is the entry point. Key modules:

| File | Purpose |
|------|---------|
| `src/db.ts` | Public DB facade — re-exports `src/db/*` with cache-invalidating wrappers |
| `src/commandRouter.ts` | Shared message → SFX/command handler; single global cooldown |
| `src/web/server.ts` | Express app; mounts all route modules |
| `src/web/middleware.ts` | `requireAuth` / `requireMod` / `requireManager` / `requireAdmin` |
| `src/statusStore.ts` | In-memory bot state for the web panel (`/api/status`) |
| `src/mutationQueue.ts` | Serialised async mutation queue |
| `src/discordUtils.ts` | `isDiscordNotFoundError`, `tryDeleteDiscordMessage` — import from here, don't duplicate |

---

## Access Levels

| Value | Name    | Permissions |
|-------|---------|-------------|
| 0     | User    | View dashboard only |
| 1     | Mod     | + join/leave voice |
| 2     | Manager | + user list + Manager+ routes (streams, commands, counters, SFX) |
| 3     | Admin   | Full access (add/update/remove users + all above) |

Use `AccessLevel` const and `AccessLevelValue` type from `src/db/users.ts` — not raw numbers. `Manager+` means ≥ 2.

> **First-time setup:** Manually INSERT a row into `user` with your Discord ID and `access_level = 3` before first login.

---

## Key Design Decisions

**Command matching:** `trigger_command` in the DB stores the full string including prefix (e.g. `!clap`). `commandRouter.ts` takes the first word of each message, lowercases it, and queries the DB — **no prefix stripping**.

**Global cooldown:** Single `lastPlayedAt` in `commandRouter.ts`, shared across all commands/users/platforms. Controlled by `GLOBAL_COOLDOWN_MS` (default 3000 ms).

**Discord gateway ready delay:** `discordBot.ts` waits **2 s after `ready`** before `connect()`. Intentional race-condition guard — do not remove.

**Voice adapter:** `audioPlayer.ts` uses a custom `DiscordGatewayAdapterCreator` forwarding raw `VOICE_STATE_UPDATE` / `VOICE_SERVER_UPDATE` packets via `client.on('raw', ...)`. `guild.voiceAdapterCreator` is not used — it has type incompatibilities with discord.js v14.

**DAVE E2EE:** `@discordjs/voice` handles the DAVE handshake via `@snazzah/davey`, `libsodium-wrappers`, `tweetnacl`, `ws`. Keep all four installed.

**Twitch channels are DB-driven:** `TWITCH_CHANNELS` env var is unused. Channels are loaded from the `user` table via `getTwitchEnabledChannels()`.

**Stream monitor:** Polling every 60 s (`twitchMonitor.ts`). `getMonitorEnabled()` controls Discord posting only — tracking continues regardless. Offline events start a 5-min grace timer before deleting the announcement. On restart, `restartTwitchMonitor()` calls the startup live-check to re-sync existing Discord messages.

**Shadow mode (custom commands / counters):** Live replies gated behind `CUSTOM_COMMANDS_LIVE_REPLIES=true`. Counter writes gated behind `COUNTER_LIVE_WRITES=true`. Both default `false`.

**`customCommands.ts` owns its cache:** Write functions call `invalidateLookupCache()` internally. Don't add a second call in `db.ts` wrappers.

**MySQL 8 upsert:** Use row-alias form (`VALUES (...) AS new_row`) not deprecated `VALUES(column)`. Requires MySQL 8.0.19+.

**Session cookie:** `NODE_ENV=production` automatically sets `cookie: { secure: true }` + `trust proxy 1` in `src/web/server.ts`.

**Auth:** `passport`/`passport-discord` are not used. Discord OAuth2 is implemented directly in `src/web/routes/auth.ts` with `fetch`.

**Weighted random — weight 0 treated as 1:** `soundSelector.ts` treats weight ≤ 0 as 1. Files are never excluded by weight; only the `hidden` flag affects listing.

---

## Patterns

### Adding a new web route
1. `src/web/routes/newroute.ts` — export an Express `Router` (use `commands.ts` as reference)
2. Mount in `src/web/server.ts`
3. Guard with middleware from `src/web/middleware.ts`
4. POST: redirect `?error=code` on failure, redirect clean on success
5. GET: load data → `res.render('view', { data, error: req.query.error })`

### Adding a new DB query function
1. Write a pure DB call in the right `src/db/` module
2. Re-export from `src/db.ts`
3. Wrap in `db.ts` for cache invalidation if needed (see `upsertUser`), or handle inside the module if it owns the cache (see `customCommands.ts`)

### Adding a new command handler
1. `src/newCommandHandler.ts` — export `registerXRuntime(runtime)` to store the platform client
2. Call from `src/index.ts` after the bot client is ready
3. Record matched commands via `commandMonitorStore`
