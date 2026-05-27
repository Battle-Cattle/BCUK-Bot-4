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

Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review or when the above commands don't surface enough context. After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

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
- **Discord error helpers live in `src/discordUtils.ts`** (`isDiscordNotFoundError`, `tryDeleteDiscordMessage`) — import from there, don't duplicate the predicate inline.

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

**Command matching:** `trigger_command` stores the full string including prefix (e.g. `!clap`). `commandRouter.ts` lowercases the first word and queries the DB directly — **no prefix stripping**.

**Discord gateway ready delay:** `discordBot.ts` waits **2 s after `ready`** before `connect()`. Intentional race-condition guard — do not remove.

**Voice adapter:** `audioPlayer.ts` uses a custom `DiscordGatewayAdapterCreator` forwarding raw `VOICE_STATE_UPDATE` / `VOICE_SERVER_UPDATE` via `client.on('raw', ...)`. `guild.voiceAdapterCreator` is not used — it has type incompatibilities with discord.js v14.

**Twitch channels are DB-driven:** `TWITCH_CHANNELS` env var is unused. Channels are loaded from the `user` table via `getTwitchEnabledChannels()`.

**Stream monitor toggle:** `getMonitorEnabled()` controls Discord posting only — stream tracking continues regardless. Toggling ON calls `catchUpDiscordPosts()` for currently-live streams.

**Shadow mode (custom commands / counters):** Live replies gated behind `CUSTOM_COMMANDS_LIVE_REPLIES=true`. Counter writes gated behind `COUNTER_LIVE_WRITES=true`. Both default `false`.

**`customCommands.ts` owns its cache:** Write functions call `invalidateLookupCache()` internally. Don't add a second call in `db.ts` wrappers.

**MySQL 8 upsert:** Use row-alias form (`VALUES (...) AS new_row`) not deprecated `VALUES(column)`. Requires MySQL 8.0.19+.

**Session cookie:** `NODE_ENV=production` automatically sets `cookie: { secure: true }` + `trust proxy 1` in `src/web/server.ts`.

**Auth:** `passport`/`passport-discord` are not used. Discord OAuth2 is implemented directly in `src/web/routes/auth.ts` with `fetch`.

---

## Patterns

**New web route:** Create `src/web/routes/newroute.ts` (use `commands.ts` as reference), export a `Router`, mount in `src/web/server.ts`, guard with the right middleware. POST → redirect `?error=code` on failure. GET → `res.render('view', { data, error: req.query.error })`.

**New DB query:** Write a pure DB call in `src/db/`, re-export from `src/db.ts`, wrap in `db.ts` for cache invalidation if needed (see `upsertUser`), or handle inside the module if it owns the cache (see `customCommands.ts`).

**New command handler:** Export `registerXRuntime(runtime)` from `src/newCommandHandler.ts` to store the platform client (avoids circular imports). Call it from `src/index.ts` after the bot client is ready. Record matched commands via `commandMonitorStore`.
