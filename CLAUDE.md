# BCUK Bot 4 — Claude Code Instructions

## Project Overview

A multi-platform community bot for Twitch, Discord, and TikTok with a web control panel, Discord OAuth login, role-based access, stream monitoring, custom commands, counters, and voice features. Weighted-random SFX playback is one subsystem of the bot, not its sole purpose.

**Tech stack:** TypeScript + Node.js (CommonJS), discord.js v14, tmi.js, tiktok-live-connector, mysql2, Express + EJS, express-session.

---

## Development Workflow

### Runtime requirement
Node.js **22.x** (matches CI). Run with `nvm use 22` if needed.

### Verify your changes
After any code change, run both:
```bash
npx tsc --noEmit   # type-check (must produce no output)
npm test           # unit tests via Vitest (must all pass)
```
CI runs `npm run build && npm test` — the build step uses `tsconfig.build.json` which excludes test files.

### Testing
```bash
npm test           # run all tests once
npm run test:watch # re-run on file change (dev)
```
Tests live alongside source as `*.test.ts` files (e.g. `src/commandRouter.test.ts`, `src/db/lookupCache.test.ts`).

### No linter / formatter
There is **no ESLint or Prettier** configured. `.qlty/` is a CI-only security/smell scanner — do not attempt to run `eslint` or `prettier` locally.

### TypeScript / import style
- `tsconfig.json` — used by `ts-node` (dev); includes test files
- `tsconfig.build.json` — used by `npm run build`; excludes test files
- Output is **CommonJS** (no `"type": "module"` in package.json). Relative imports do **not** need `.js` extensions.

### Database migrations
SQL migration scripts live in `migrations/`. They are applied **manually** against the MySQL database — there is no migration runner. Run them with `mysql -u <user> -p <db> < migrations/<file>.sql`.

---

## Repository Structure

```text
BCUK_Bot_4/
├── src/
│   ├── index.ts                      — Entry point: starts all services
│   ├── config.ts                     — Reads & validates all env vars
│   ├── db.ts                         — Public DB facade: re-exports from src/db/* with cache-invalidating wrappers
│   ├── db/
│   │   ├── pool.ts                   — MySQL connection pool
│   │   ├── users.ts                  — User queries (find, upsert, access level, Twitch enablement)
│   │   ├── sfx.ts                    — SFX trigger and file queries
│   │   ├── customCommands.ts         — Custom command CRUD + assignment queries
│   │   ├── counters.ts               — Counter CRUD and increment queries
│   │   ├── streamMonitor.ts          — Stream group and streamer queries
│   │   ├── streamdeckKeys.ts         — Streamdeck key binding queries
│   │   ├── eventSub.ts               — Twitch EventSub subscription persistence
│   │   ├── overlayVideos.ts          — Overlay video asset queries
│   │   ├── lookupCache.ts            — Generic refresh-able in-memory lookup cache
│   │   ├── lookupCache.test.ts
│   │   ├── commandConflicts.ts       — Detect conflicting command trigger strings
│   │   ├── commandLocks.ts           — DB-level command mutation locks
│   │   ├── commandStringUtils.ts     — Shared command string normalization
│   │   ├── reservedCommands.ts       — Built-in reserved command registry
│   │   └── utils.ts                  — Shared DB helpers (bigint/buffer handling etc.)
│   ├── commandRouter.ts              — Shared message → SFX/command handler
│   ├── commandRouter.test.ts
│   ├── commandUtils.ts               — Shared command matching utilities
│   ├── soundSelector.ts              — Weighted-random file picker
│   ├── sfxPlayer.ts                  — Creates audio resources from SFX files
│   ├── sfxPlayer.test.ts
│   ├── audioPlayer.ts                — @discordjs/voice connection + playback
│   ├── voiceAdapter.ts               — Custom Discord gateway adapter for @discordjs/voice
│   ├── audioConnectionHandlers.ts    — Voice state event management
│   ├── statusStore.ts                — In-memory bot state (for web panel)
│   ├── discordBot.ts                 — discord.js client + message listener
│   ├── discordUtils.ts               — Shared Discord error helpers (isDiscordNotFoundError, tryDeleteDiscordMessage)
│   ├── twitchBot.ts                  — tmi.js client + message listener
│   ├── tiktokBot.ts                  — tiktok-live-connector + auto-reconnect
│   ├── twitchApi.ts                  — Twitch Helix API wrapper (app token, getUsers, getStreams)
│   ├── twitchApiEventSub.ts          — Twitch EventSub REST API wrapper
│   ├── twitchEventSub.ts             — EventSub WebSocket client
│   ├── twitchEventSubHandler.ts      — EventSub event dispatching
│   ├── twitchEventSubSubscriptions.ts— EventSub subscription management
│   ├── twitchMonitor.ts              — Polling-based stream monitor (coordinator)
│   ├── twitchMonitorAnnouncements.ts — Discord embed posting/editing/deleting
│   ├── twitchMonitorEmbed.ts         — Embed builder
│   ├── twitchMonitorMultitwitch.ts   — MultiTwitch link generation and embed injection
│   ├── twitchMonitorOffline.ts       — Offline grace-period timer logic
│   ├── twitchMonitorStartup.ts       — Startup live-check and reconciliation
│   ├── twitchMonitorTypes.ts         — Shared types for the monitor subsystem
│   ├── twitchChannelName.ts          — Twitch channel-name normalization helper
│   ├── customCommandHandler.ts       — Custom command runtime (match, record, reply)
│   ├── multiCommandHandler.ts        — Multi-channel command broadcast handler
│   ├── counterHandler.ts             — Counter command execution (increment/check, shadow mode)
│   ├── counterScheduler.ts           — Yearly Jan 1 archive-and-reset scheduler
│   ├── shoutoutHandler.ts            — Shoutout command handler
│   ├── countdownHandler.ts           — Countdown display handler
│   ├── commandMonitorStore.ts        — In-memory command audit log
│   ├── mutationQueue.ts              — Serialised async mutation queue
│   ├── mutationQueue.test.ts
│   ├── crypto.ts                     — Cryptographic helpers
│   ├── logger.ts                     — Winston logging setup
│   ├── monitorSettings.ts            — Read/write monitor-settings.json (toggle only)
│   ├── types/
│   │   └── express.d.ts              — Augments express-session SessionData
│   └── web/
│       ├── server.ts                 — Express app + startWebPanel()
│       ├── csrf.ts                   — CSRF token middleware for web forms
│       ├── middleware.ts             — requireAuth / requireMod / requireManager / requireAdmin
│       └── routes/
│           ├── shared.ts             — Shared route utilities
│           ├── auth.ts               — Discord OAuth2 (manual, no passport)
│           ├── dashboard.ts          — GET / → renders dashboard
│           ├── admin.ts              — User list page (GET /admin/users)
│           ├── adminRefresh.ts       — Bulk Discord-name background refresh
│           ├── adminUserMutations.ts — User CRUD mutations (add/update/remove/toggle)
│           ├── adminUserMutations.test.ts
│           ├── api.ts                — GET /api/status, POST /api/voice/join|leave
│           ├── streams.ts            — Stream group/streamer CRUD + toggle
│           ├── commands.ts           — Custom command CRUD + assignment management
│           ├── counters.ts           — Counter CRUD + manual reset management
│           ├── sfx.ts                — SFX trigger/file management (Manager+)
│           ├── sfxPublic.ts          — Public SFX listing endpoint
│           ├── commandMonitor.ts     — Command audit log viewer
│           ├── overlayAdmin.ts       — OBS overlay admin management
│           ├── overlaySource.ts      — OBS overlay source endpoint
│           ├── streamdeck.ts         — Streamdeck integration page
│           ├── streamdeckKeys.ts     — Streamdeck key binding CRUD
│           ├── userSettings.ts       — User preference management
│           ├── eventsubAdmin.ts      — EventSub subscription admin page
│           └── eventsubCallback.ts   — EventSub webhook callback handler
├── views/
│   ├── partials/nav.ejs
│   ├── partials/pwa-head.ejs
│   ├── partials/pwa-register.ejs
│   ├── login.ejs
│   ├── dashboard.ejs
│   ├── admin.ejs
│   ├── commands.ejs
│   ├── counters.ejs
│   ├── streams.ejs
│   └── error.ejs
├── public/
│   ├── style.css
│   ├── app.js
│   ├── navbar.js
│   ├── admin.js
│   ├── streams.js
│   ├── commands.js
│   ├── counters.js
│   ├── pwa-register.js
│   ├── service-worker.js
│   ├── manifest.json
│   ├── offline.html
│   └── icons/
├── sfx/                              — Sound files go here (not in git)
├── migrations/                       — Database migration scripts
├── DATABASE-SCHEMA.md                — Full database schema reference
├── monitor-settings.json             — Local settings (gitignored): toggle state only
├── .env.example
├── .gitignore
├── package.json
└── tsconfig.json
```

---

## Database Schema

See **`DATABASE-SCHEMA.md`** for the full schema. Brief table summary:

| Table | Purpose |
|-------|---------|
| `sfxtrigger` | SFX trigger commands (includes prefix, e.g. `!clap`) |
| `sfx` | Individual sound files per trigger with weights |
| `sfxcategory` | Category labels for SFX |
| `user` | Bot users (Discord ID + Twitch name + access level) |
| `stream_group` | Discord announcement channel configuration |
| `streamer` | Twitch usernames monitored per group |
| `custom_command` | Custom command text replies |
| `twitch_user_commands` | User→command assignment (multi-Twitch broadcast) |
| `counter` | Increment/check counters with yearly archiving |
| `sessions` | Express sessions (auto-created by express-mysql-session) |

---

## Environment Variables

Copy `.env.example` → `.env` and fill in all values.

| Variable                | Required | Notes |
|-------------------------|----------|-------|
| `DISCORD_TOKEN`         | ✅ | Bot token (not OAuth app) |
| `DISCORD_GUILD_ID`      | ✅ | Server ID |
| `DISCORD_VOICE_CHANNEL_ID` | ✅ | Voice channel to join |
| `TWITCH_USERNAME`       | ✅ | Bot account username |
| `TWITCH_OAUTH_TOKEN`    | ✅ | Format: `oauth:xxxx` |
| `TIKTOK_CHANNELS`       | ❌ | Comma-separated usernames (@ optional) |
| `TIKTOK_SIGN_API_KEY`   | ❌ | From eulerstream.com, improves reliability |
| `DB_HOST`               | ❌ | Default: localhost |
| `DB_PORT`               | ❌ | Default: 3306 |
| `DB_USER`               | ✅ | |
| `DB_PASSWORD`           | ✅ | |
| `DB_NAME`               | ✅ | |
| `SFX_FOLDER`            | ❌ | Default: `./sfx` |
| `GLOBAL_COOLDOWN_MS`    | ❌ | Default: 3000 |
| `WEB_PORT`              | ❌ | Default: 3000 |
| `SESSION_SECRET`        | ✅ | Long random string |
| `DISCORD_CLIENT_ID`     | ✅ | OAuth2 app Client ID |
| `DISCORD_CLIENT_SECRET` | ✅ | OAuth2 app Client Secret |
| `DISCORD_CALLBACK_URL`  | ✅ | e.g. `http://localhost:3000/auth/discord/callback` |
| `TWITCH_CLIENT_ID`      | ✅ | Twitch app Client ID — for stream monitoring (separate from chat bot) |
| `TWITCH_CLIENT_SECRET`  | ✅ | Twitch app Client Secret — for stream monitoring |
| `CUSTOM_COMMANDS_LIVE_REPLIES` | ❌ | Default: `false`. When `false`, custom command and counter matches are recorded for monitoring but no reply is sent (shadow mode). Set to `true` to enable live replies. |
| `COUNTER_LIVE_WRITES` | ❌ | Default: `false`. When `false`, counter trigger commands are matched and logged but `current_value` is not incremented (shadow mode). Set to `true` to enable live increments. |

---

## Access Levels

| Value | Name    | Permissions |
|-------|---------|-------------|
| 0     | User    | View dashboard only |
| 1     | Mod     | View dashboard + join/leave voice channel |
| 2     | Manager | View dashboard + user list + join/leave voice + Manager+ admin routes (stream monitor, custom commands, and counters) |
| 3     | Admin   | Full access: add/update/remove users + all above |

`Manager+` in the route table means access level 2 or 3 (`Manager` or `Admin`).

> **First-time setup:** Manually INSERT a row into the `user` table with your Discord ID and `access_level = 3` before first login.

---

## Key Design Decisions

### Command Matching
`trigger_command` in the DB stores the **full command string including any prefix** (e.g. `!clap`, `?sound`). `commandRouter.ts` takes the first word of each message, lowercases it, and queries the DB directly — **no prefix stripping is performed in code**.

### Global Cooldown
`commandRouter.ts` has a **single global** `lastPlayedAt` timestamp — one cooldown shared across all commands, all users, all platforms. There is no per-command, per-user, or per-channel cooldown. Controlled by `GLOBAL_COOLDOWN_MS` (default 3000 ms).

### Discord Gateway Ready Delay
`discordBot.ts` waits **2 seconds after the `ready` event** before calling `connect()` to join the voice channel. This delay is intentional — it prevents a race condition where the voice join packet arrives before the gateway is fully settled. Do not remove it.

### Opus / Audio
`@discordjs/opus` is not installed. `opusscript` (pure-JS) is used as the Opus provider for `@discordjs/voice`.

### Weighted Random — Weight 0 Treated as 1
`soundSelector.ts` treats a weight of `0` (or any non-positive value) the same as `1`. If all files for a trigger have `weight = 0`, selection is uniform across all files — they are **not excluded**. Only the `hidden` flag affects listing; weight only affects selection probability.

### mediaplex — must be first import
`src/index.ts` imports `mediaplex` as its **very first line** (`import 'mediaplex'`). This registers mediaplex as the Opus provider before any other module loads. Moving or removing this import will silently break audio playback. Never reorder it.

### Discord privileged gateway intent
`GatewayIntentBits.MessageContent` is a **privileged intent** — it must be explicitly enabled in the Discord Developer Portal (Bot → Privileged Gateway Intents) in addition to being listed in code. Without it, `message.content` will always be an empty string.

### Graceful shutdown
`src/index.ts` registers `SIGINT` and `SIGTERM` handlers that call `disconnect()` from `audioPlayer.ts` before `process.exit(0)`. This ensures the bot leaves the voice channel cleanly when stopped (e.g. Ctrl+C in dev, `pm2 stop` or `kill` in production) rather than appearing present in the channel until Discord times out.

### Discord error helpers (`src/discordUtils.ts`)
Shared utilities for Discord API error handling. `isDiscordNotFoundError(err)` returns `true` when `err` is a `DiscordAPIError` with code `UnknownMessage` (10008), `UnknownChannel` (10003), or HTTP status 404 — i.e. the resource is gone and no action is needed. `tryDeleteDiscordMessage(channelId, messageId)` fetches and deletes a message, silently returning on not-found errors and logging + rethrowing all others. Import from here rather than duplicating the predicate inline.

### Exported Discord client
`src/discordBot.ts` exports `discordClient: Client | null`. It is `null` until the `ready` event fires, then set to the live `Client` instance. Other modules (e.g. `src/web/routes/api.ts`) import this to call Discord APIs without holding a circular reference to the full bot module.

### Twitch channels are DB-driven
`TWITCH_CHANNELS` is no longer used. `startTwitchBot()` loads enabled Twitch channels from the `user` table via `getTwitchEnabledChannels()`, and admin user updates/toggles reconcile live channel membership with `joinTwitchChannel()` / `partTwitchChannel()`.

### Twitch user ownership is unique
Each `user.twitch_name` must belong to at most one user row. The database enforces this with a unique index on `user.twitch_name` using a case-insensitive collation, and the admin add/update flow also pre-checks for duplicates so most conflicts can be shown as a friendly validation error before the write races the database constraint. `findUserByTwitchName()` compares directly against the normalized parameter so MySQL can use that index.

### Voice join/leave from web panel
`audioPlayer.ts` exports both `connect(client)` (join) and `disconnect()` (leave). `POST /api/voice/join` and `POST /api/voice/leave` in `src/web/routes/api.ts` are guarded by `requireMod` (access level ≥ 1). The dashboard shows a **Join Voice** / **Leave Voice** toggle button to Mod+ users; the button label and state are kept in sync by `applyStatus()` on every poll.

### Auth
`passport` and `passport-discord` were **not used** — they are deprecated. Discord OAuth2 is implemented directly in `src/web/routes/auth.ts` using `fetch` calls to the Discord API.

### Login-time Discord name sync
During OAuth login, `auth.ts` treats Discord display-name sync as non-blocking: it prefers the current guild display name from `fetchMemberDisplayName(..., true)`, falls back to the stored `discord_name` (or OAuth username if none exists), and only updates the DB when the final value changed.

### dotenv
`config.ts` calls `dotenv.config()` (no `override` flag). System environment variables set before the process starts take precedence over `.env` values — this is the default dotenv behaviour.

### Session augmentation
`src/types/express.d.ts` augments `express-session`'s `SessionData` interface (not the `Express` namespace) to add `user?: SessionUser` and `oauthState?: string`. `tsconfig.json` has `"ts-node": { "files": true }` so ts-node loads this ambient declaration.

### Voice adapter (custom raw gateway adapter)
`guild.voiceAdapterCreator` is **not used**. Instead, `audioPlayer.ts` builds a custom `DiscordGatewayAdapterCreator` that listens to `client.on('raw', ...)` and manually forwards `VOICE_STATE_UPDATE` and `VOICE_SERVER_UPDATE` packets to `@discordjs/voice`. This is required because the built-in adapter has type/version incompatibilities with discord.js v14.

### DAVE E2EE voice protocol
Discord requires the DAVE (E2EE) protocol for voice connections. The current stable `@discordjs/voice` package handles this handshake when the required crypto libs are installed (`@snazzah/davey`, `libsodium-wrappers`, `tweetnacl`, `ws`). Keep these dependencies installed together.

### PWA + offline behavior
The web panel is PWA-enabled. `public/service-worker.js` pre-caches core static assets, serves `public/offline.html` as a navigation fallback when offline, and bypasses auth/API/admin endpoints to avoid caching sensitive or session-dependent responses. `views/partials/pwa-head.ejs` and `views/partials/pwa-register.ejs` must stay included in pages that should support install/offline behavior.

### TikTok reconnect dedup
`tiktokBot.ts` uses a per-connection `reconnectScheduled` boolean to prevent duplicate `setTimeout` calls when both `STREAM_END` and `DISCONNECTED` fire for the same connection.

### MySQL tinyint(1) / bit columns returned as Buffer
Some MySQL configurations/drivers can return `tinyint(1)` or `bit` columns as a single-byte `Buffer` rather than `0`/`1`. All boolean reads use the pattern in `src/db/utils.ts`:
```ts
Buffer.isBuffer(row.hidden) ? row.hidden[0] === 1 : row.hidden == 1
```
Apply this same pattern whenever reading any boolean/tinyint column.

### MySQL BIGINT IDs must stay as strings
Discord IDs and other snowflake-style values in MySQL can exceed JavaScript's safe integer range. `src/db/pool.ts` configures mysql2 with `supportBigNumbers: true` and `bigNumberStrings: true` so BIGINT values are returned as exact strings instead of rounded numbers. Preserve that behavior for any future pool or connection changes.

### Blank Twitch names should be stored as NULL
Because `user.twitch_name` is protected by a unique index, blank values must not be stored as empty strings. `upsertUser()` normalizes blank Twitch names to `NULL`, which allows multiple users with no Twitch channel while still enforcing uniqueness for real channel names.

### MySQL 8 upsert syntax
The project targets MySQL 8 semantics. For `INSERT ... ON DUPLICATE KEY UPDATE`, prefer the row-alias form (`VALUES (...) AS new_row`) instead of deprecated `VALUES(column)` expressions. This alias form requires MySQL 8.0.19 or later; earlier 8.0 releases do not support row aliases in `INSERT ... VALUES (...) AS alias`.

### Session cookie in production
`src/web/server.ts` automatically sets `cookie: { secure: true }` and `app.set('trust proxy', 1)` when `NODE_ENV=production`. In development (default), `secure: false` is used so cookies work over plain HTTP. No manual code changes are needed — just set `NODE_ENV=production` when deploying behind an HTTPS reverse proxy.

### Twitch stream monitor — polling-based
`twitchMonitor.ts` uses **polling** (every 60 s via `setInterval`) rather than EventSub WebSocket subscriptions. `getStreams()` is called on each poll tick; the module keeps an in-memory `liveStates` map and reconciles against the Helix response to detect go-live, game-change, and go-offline events.

### Twitch stream monitor — Discord posts vs tracking
`getMonitorEnabled()` (from `monitorSettings.ts`) controls **whether Discord messages are posted or edited** only. Stream tracking (the in-memory `liveStates` map + DB state) continues regardless of the toggle. Toggling ON calls `catchUpDiscordPosts()` which posts/edits Discord messages for all currently-tracked live streams.

### Twitch stream monitor — offline grace period
When a stream appears offline in a poll, `handleStreamOffline()` starts a 5-minute `setTimeout` before confirming offline and deleting the Discord announcement. If the stream comes back within that window (e.g. a brief outage) the timer is cancelled and no changes are made to Discord.

### Twitch stream monitor — startup live-check
On `startTwitchMonitor()`, after loading streamers from DB, `performStartupLiveCheck()` is called. It queries Helix for all monitored user IDs and reconciles against the stored `discord_message_id`/`live_game` columns: live + has message → edit; live + no message → post fresh; offline + has message → delete and clear DB; offline + no message → no-op.

### Twitch stream monitor — multitwitch
When ≥2 streamers in the same group are live on the same game, each matching Discord embed gets a `MultiTwitch` field added containing `https://www.multitwitch.tv/login1/login2/...`. `updateMultitwitch(groupId)` is called after any live-state change (go-live, game-change, go-offline).

### Twitch stream monitor — hot reload
Any CRUD change to groups or streamers via the web panel calls `restartTwitchMonitor()` which tears down the poll timer, clears in-memory state, and re-runs `startTwitchMonitor()` (including startup live-check). Existing Discord messages are NOT deleted on restart; the live-check will re-sync them.

### Twitch stream monitor — process exit
`index.ts` calls `stopTwitchMonitor()` on `SIGINT`/`SIGTERM`. This stops the poll timer and clears in-memory state **without deleting Discord announcement messages** — they are left in place so the startup live-check on the next boot can re-sync them. `shutdownTwitchMonitor()` (which does delete all messages) is intentionally not used on process exit.

### monitor-settings.json
Local file (`monitor-settings.json` at `process.cwd()`) persists one value: `twitchMonitorEnabled` (boolean, default `true` if file missing). It is **gitignored**. Read/write via `src/monitorSettings.ts` helpers only.

### Custom commands and counters are panel-first
`/admin/commands` and `/admin/counters` currently provide management CRUD in the web panel.

**Custom command runtime** is implemented in `src/customCommandHandler.ts`. Commands are matched and recorded for monitoring on both Twitch and Discord. Live replies are gated behind `CUSTOM_COMMANDS_LIVE_REPLIES` (default `false` — shadow mode). Multi-Twitch broadcast (shared-chat dedup via Helix) is wired and ready.

**Counter runtime** is implemented in `src/counterHandler.ts`. Counter trigger commands increment `current_value` when `COUNTER_LIVE_WRITES=true`; counter check commands read the current value without writing. Both trigger and check replies are gated behind `CUSTOM_COMMANDS_LIVE_REPLIES`. In shadow mode, trigger commands log `(preview only — counter not incremented)` to the command monitor but do not mutate the DB.

**Counter yearly scheduler** (`src/counterScheduler.ts`) runs once per year at midnight Jan 1. For all counters with `reset_yearly=true` it copies `current_value` to the `value{YYYY}` archive column (e.g. `value2024`) and resets `current_value` to 0. The `value{YYYY}` column must exist in the DB before the scheduler runs — add it manually each year (see DATABASE-SCHEMA.md).

### Modular database layer (`src/db/`)
Query functions live in focused modules under `src/db/` (users, sfx, customCommands, counters, streamMonitor, eventSub, etc.). `src/db.ts` is the **public facade** — it re-exports everything other modules need and wraps some functions with cache-invalidation side effects. Always import DB functions from `src/db.ts`, not directly from `src/db/*`.

---

## Scripts

```bash
npm run dev      # ts-node src/index.ts (development)
npm run build    # tsc → dist/
npm start        # node dist/index.js (production)
```

---

## Package Notes

- `@discordjs/voice` is pinned to the stable `^0.19.2` line.
- `@snazzah/davey`, `libsodium-wrappers`, `tweetnacl`, and `ws` are part of the voice crypto/runtime stack used by `@discordjs/voice`.
- `opusscript` is installed as the JS Opus provider and `mediaplex` is imported first in `src/index.ts` to register it.
- `ffmpeg-static` provides the ffmpeg binary for audio transcoding.
- `helmet` is enabled in the web app for secure response headers.
- `"overrides": { "undici": "^7.24.0" }` in `package.json` pins the transitive `undici` version.
- `npm audit` should report **0 vulnerabilities**.
- TypeScript: `npx tsc --noEmit` should produce **no output** (clean).

---

## Web Panel Routes

| Method | Path                                | Guard       | Description |
|--------|-------------------------------------|-------------|-------------|
| GET    | `/auth/login`                       | —           | Login page |
| GET    | `/auth/discord`                     | —           | Start OAuth2 flow |
| GET    | `/auth/discord/callback`            | —           | OAuth2 callback |
| POST   | `/auth/logout`                      | requireAuth + CSRF | Destroy session |
| GET    | `/`                                 | requireAuth | Dashboard |
| GET    | `/api/status`                       | requireAuth | JSON status snapshot |
| POST   | `/api/voice/join`                   | Mod+        | Join configured voice channel |
| POST   | `/api/voice/leave`                  | Mod+        | Leave voice channel |
| GET    | `/admin/users`                      | Manager+    | User list |
| POST   | `/admin/users/refresh-names`        | Manager+    | Start background Discord-name refresh |
| GET    | `/admin/users/refresh-status`       | Manager+    | JSON status for background Discord-name refresh |
| POST   | `/admin/users/add`                  | Admin       | Add/update user |
| POST   | `/admin/users/toggle-twitch`        | Manager+    | Enable/disable Twitch bot participation for one user |
| POST   | `/admin/users/update`               | Admin       | Change access level |
| POST   | `/admin/users/remove`               | Admin       | Remove user |
| GET    | `/admin/streams`                    | Manager+    | Stream monitor management page |
| GET    | `/admin/streams/live`               | Manager+    | JSON snapshot of currently live streams |
| POST   | `/admin/streams/toggle`             | Manager+    | Enable/disable Discord announcements |
| POST   | `/admin/streams/groups/add`         | Manager+    | Add stream group |
| POST   | `/admin/streams/groups/update`      | Manager+    | Update stream group |
| POST   | `/admin/streams/groups/remove`      | Manager+    | Remove stream group (and its streamers) |
| POST   | `/admin/streams/streamers/add`      | Manager+    | Add streamer to group |
| POST   | `/admin/streams/streamers/remove`   | Manager+    | Remove streamer |
| GET    | `/admin/commands`                   | Manager+    | Custom command management page |
| POST   | `/admin/commands/add`               | Manager+    | Add custom command |
| POST   | `/admin/commands/update`            | Manager+    | Update custom command |
| POST   | `/admin/commands/remove`            | Manager+    | Remove custom command |
| POST   | `/admin/commands/assign`            | Manager+    | Assign user to custom command |
| POST   | `/admin/commands/unassign`          | Manager+    | Remove user assignment from custom command |
| GET    | `/admin/counters`                   | Manager+    | Counter management page |
| POST   | `/admin/counters/add`               | Manager+    | Add counter definition |
| POST   | `/admin/counters/update`            | Manager+    | Update counter definition |
| POST   | `/admin/counters/remove`            | Manager+    | Remove counter definition |
| POST   | `/admin/counters/reset/:id`         | Manager+    | Manually reset current_value to 0 |
| GET    | `/admin/sfx`                        | Manager+    | SFX management page |
| GET    | `/sfx`                              | —           | Public SFX listing |
| GET    | `/admin/command-monitor`            | Manager+    | Command audit log viewer |
| GET    | `/overlay`                          | —           | OBS overlay source |
| GET    | `/admin/overlay`                    | Manager+    | Overlay admin page |
| GET    | `/streamdeck`                       | requireAuth | Streamdeck integration page |
| GET/POST | `/streamdeck/keys`               | requireAuth | Streamdeck key binding management |
| GET/POST | `/settings`                      | requireAuth | User preferences |
| GET    | `/admin/eventsub`                   | Admin       | EventSub subscription management |
| POST   | `/eventsub/callback`                | —           | EventSub webhook callback (Twitch-signed) |

---

## Status Store (`src/statusStore.ts`)

In-memory singleton. Functions:

- `setDiscordReady(tag, guildName)`
- `setVoiceConnected(channelName)` / `setVoiceDisconnected()` / `setVoiceIdle()`
- `setVoicePlaying(file, command, source)`
- `setTwitchChannel(channel, connected)`
- `setTikTokChannel(username, connected)`
- `getStatus()` → snapshot consumed by `/api/status` and dashboard render

---

## Database Query Functions (`src/db/` + `src/db.ts`)

Query functions are split across focused modules in `src/db/`; import them via the public facade `src/db.ts`.

- **`src/db/sfx.ts`** — `findTrigger(command)`, `findSoundFiles(triggerId)`, `getAllSfxTriggers()`
- **`src/db/users.ts`** — `findUser`, `findUserByTwitchName`, `getAllUsers`, `upsertUser` (cache-invalidating wrapper in `db.ts`), `updateAccessLevel`, `removeUser`, `updateDiscordName`, `getTwitchEnabledChannels`, `updateTwitchBotEnabled`; exports `AccessLevel` const (`USER=0 MOD=1 MANAGER=2 ADMIN=3`) and `AccessLevelValue` type — use these instead of raw numbers
- **`src/db/streamMonitor.ts`** — `getAllStreamersWithGroups`, `getAllStreamGroups`, `getAllStreamers`, `addStreamGroup`, `updateStreamGroup`, `removeStreamGroup`, `addStreamer`, `removeStreamer`, `removeStreamersByGroup`, `setStreamerLive`, `clearStreamerLive`; exports `DbStreamGroup`, `DbStreamerFull`
- **`src/db/customCommands.ts`** — `getAllCustomCommandsWithAssignments`, `addCustomCommand`, `updateCustomCommand`, `removeCustomCommand`, `assignUserToCommand`, `unassignUserFromCommand`; exports `DbCustomCommand`, `DbCustomCommandWithAssignments`
- **`src/db/counters.ts`** — `getAllCounters`, `addCounter`, `updateCounter`, `removeCounter`, `resetCounterCurrentValue`; exports `DbCounter`
- **`src/db/eventSub.ts`** — EventSub subscription persistence queries
- **`src/db/lookupCache.ts`** — Generic `ManagedLookupCache` with TTL refresh
- **`src/db/pool.ts`** — `getPool()`, `closePool()`; configures mysql2 with bigint-as-string
- **`src/db/utils.ts`** — `boolFromDb(val)` and other shared DB value helpers

> **Note:** In-memory state (statusStore, commandMonitorStore) is lost on process restart. Sessions are stored in the `sessions` MySQL table via `express-mysql-session` (created automatically on first run).

---

## Common Pitfalls

### Always import DB functions from `src/db.ts`, never from `src/db/*` directly
`src/db.ts` is the public facade. Some functions (e.g. `upsertUser`, `updateTwitchBotEnabled`, `removeUser`) are **wrapped** in `db.ts` to add cache-invalidation side effects. Importing directly from `src/db/users.ts` bypasses those wrappers and leaves the lookup cache stale.

### Use `mutationQueue` for concurrent-unsafe DB writes
`src/mutationQueue.ts` serialises operations by key. Admin user mutations (`upsertUser`, `removeUser`, `updateAccessLevel`, `updateTwitchBotEnabled`) use it to prevent races when two web requests touch the same user record. Any new mutation flow that can race should use the same pattern.

### `src/db/customCommands.ts` manages its own cache
Unlike user mutations (which are wrapped in `db.ts`), the custom-command write functions (`addCustomCommand`, `updateCustomCommand`, etc.) call `invalidateLookupCache()` internally. Do not add a second invalidation call in `db.ts` wrappers — it would be a no-op but signals a misunderstanding of ownership.

### Buffer/bigint on DB reads
MySQL may return `tinyint(1)`/`bit` columns as a single-byte `Buffer`. Always use `boolFromDb()` from `src/db/utils.ts` (or the inline pattern) rather than a plain `=== 1` comparison. BIGINT columns are returned as strings — never coerce them to `Number`.

### POST routes redirect, they don't render errors inline
All mutation routes (add/update/remove) redirect back to the list page with an `?error=code` query param on failure. The GET handler reads that param and passes it to the EJS template. Do not try to render an error response directly from a POST handler.

---

## Patterns

### Adding a new web route
1. Create `src/web/routes/newroute.ts` — use `src/web/routes/commands.ts` as a reference
2. Export an Express `Router`
3. Mount it in `src/web/server.ts` with the appropriate path prefix
4. Guard with `requireAuth` / `requireMod` / `requireManager` / `requireAdmin` from `src/web/middleware.ts`
5. POST handlers: validate input, perform mutation, then `res.redirect('/path?error=code')` on failure or `res.redirect('/path')` on success
6. GET handlers: load data, pass to `res.render('view', { data, error: req.query.error })`

### Adding a new DB query function
1. Find the right module in `src/db/` (or create a new focused file)
2. Write the query function there — keep it as a pure DB call with no cache knowledge
3. Re-export it from `src/db.ts`
4. If the mutation affects cached data, wrap it in `db.ts` to add cache invalidation (see `upsertUser` for the pattern), or add invalidation inside the module if it owns the cache (see `customCommands.ts`)

### Adding a new command handler
1. Create `src/newCommandHandler.ts`
2. Export a `registerXRuntime(runtime)` function that stores the platform client reference — this avoids circular imports between the bot entry point and the handler
3. Call `registerXRuntime()` from `src/index.ts` after the bot client is ready
4. Use `commandMonitorStore` to record matched commands for the audit log

---

## Potential Future Work

- Ability to create/edit/hide SFX triggers from the web panel
- Bot activity log / recent commands on dashboard
- Twitch channel points reward handling (currently only chat commands)
- Docker / PM2 deployment config
---

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).