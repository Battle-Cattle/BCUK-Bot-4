# BCUK Bot 4 — Copilot Instructions

## Project Overview

A multi-platform SFX bot that listens to Twitch, Discord, and TikTok chat, matches messages against DB-stored commands, and plays weighted-random sound files into a Discord voice channel. Includes a web control panel with Discord OAuth login and role-based access.

**Tech stack:** TypeScript + Node.js (CommonJS), discord.js v14, tmi.js, tiktok-live-connector, mysql2, Express + EJS, express-session.

---

## Repository Structure

```text
BCUK_Bot_4/
├── src/
│   ├── index.ts              — Entry point: starts all services
│   ├── config.ts             — Reads & validates all env vars
│   ├── db.ts                 — MySQL pool + all query functions
│   ├── commandRouter.ts      — Shared message → SFX handler
│   ├── soundSelector.ts      — Weighted-random file picker
│   ├── audioPlayer.ts        — @discordjs/voice connection + playback
│   ├── statusStore.ts        — In-memory bot state (for web panel)
│   ├── discordBot.ts         — discord.js client + message listener
│   ├── twitchBot.ts          — tmi.js client + message listener
│   ├── tiktokBot.ts          — tiktok-live-connector + auto-reconnect
│   ├── twitchApi.ts          — Twitch Helix API wrapper (app token, getUsers, getStreams)
│   ├── twitchMonitor.ts      — Polling-based stream monitor + Discord announcements
│   ├── monitorSettings.ts    — Read/write monitor-settings.json (toggle + EventSub token)
│   ├── types/
│   │   └── express.d.ts      — Augments express-session SessionData
│   └── web/
│       ├── server.ts         — Express app + startWebPanel()
│       ├── middleware.ts     — requireAuth / requireMod / requireManager / requireAdmin
│       └── routes/
│           ├── auth.ts       — Discord OAuth2 (manual, no passport)
│           ├── dashboard.ts  — GET / → renders dashboard
│           ├── admin.ts      — User CRUD (GET+POST /admin/users/*)
│           ├── api.ts        — GET /api/status, POST /api/voice/join|leave
│           └── streams.ts    — Stream group/streamer CRUD + toggle + Twitch OAuth
├── views/
│   ├── partials/nav.ejs
│   ├── login.ejs
│   ├── dashboard.ejs
│   ├── admin.ejs
│   ├── streams.ejs           — Stream monitor management page
│   └── error.ejs
├── public/
│   ├── style.css             — Dark theme CSS
│   └── app.js                — Status polling, SFX search, file expand, voice join/leave
├── sfx/                      — Sound files go here (not in git)
├── monitor-settings.json     — Local settings (gitignored): toggle state + EventSub token
├── .env.example
├── .gitignore
├── package.json
└── tsconfig.json
```

---

## Database Schema

Tables in the existing MySQL/MariaDB database:

### `sfxtrigger`

| Column           | Type         | Notes                                      |
|------------------|--------------|--------------------------------------------|
| `id`             | bigint PK    |                                            |
| `trigger_command`| varchar      | Full command **including prefix** e.g. `!clap` |
| `category_id`    | int FK→sfxcategory | nullable                            |
| `hidden`         | tinyint(1)   | Excludes from public listing only — command still plays |
| `description`    | varchar      | nullable                                   |

### `sfx`

| Column           | Type         | Notes                                      |
|------------------|--------------|--------------------------------------------|
| `id`             | int PK       |                                            |
| `trigger_id`     | bigint FK→sfxtrigger |                                    |
| `file`           | varchar      | Filename relative to `SFX_FOLDER`          |
| `trigger_command`| varchar      | nullable (legacy, not used for routing)    |
| `weight`         | int          | Higher = more likely to be picked          |
| `hidden`         | tinyint(1)   | Excludes from public listing only — file still plays |
| `category_id`    | int FK→sfxcategory | nullable                            |

### `sfxcategory`

| Column | Type    |
|--------|---------|
| `id`   | int PK  |
| `name` | varchar |

### `user`

| Column                 | Type         | Notes                      |
|------------------------|--------------|----------------------------|
| `discord_id`           | varchar PK   | Discord numeric user ID    |
| `discord_name`         | varchar      | nullable                   |
| `is_twitch_bot_enabled`| tinyint(1)   |                            |
| `twitch_name`          | varchar      | nullable                   |
| `twitchoauth`          | varchar      | nullable                   |
| `access_level`         | int          | 0=USER 1=MOD 2=MANAGER 3=ADMIN |

### `stream_group`

| Column               | Type       | Notes                                      |
|----------------------|------------|--------------------------------------------|
| `id`                 | int PK     |                                            |
| `name`               | varchar    | Display name                               |
| `discord_channel`    | bigint     | Channel ID to post announcements in        |
| `live_message`       | text       | Template for go-live message               |
| `new_game_message`   | text       | Template for game-change message           |
| `multi_twitch`       | bit(1)     | Enable multitwitch links                   |
| `multi_twitch_message`| text      | Footer template when multitwitch applies   |
| `delete_old_posts`   | bit(1)     | Delete old embed on game change instead of edit |

### `streamer`

| Column                | Type        | Notes                                      |
|-----------------------|-------------|--------------------------------------------|
| `id`                  | int PK      |                                            |
| `name`                | varchar     | Twitch username (lowercase)                |
| `group_id`            | int FK→stream_group.id |                               |
| `discord_message_id`  | varchar(20) | nullable — ID of live announcement message |
| `discord_channel_id`  | bigint      | nullable — channel the announcement was posted in |
| `live_game`           | varchar(255)| nullable — game at time of last announcement |

> **DB migration** (run once before first use of stream monitoring):
> ```sql
> ALTER TABLE streamer
>   ADD COLUMN discord_message_id VARCHAR(20) DEFAULT NULL,
>   ADD COLUMN discord_channel_id BIGINT DEFAULT NULL,
>   ADD COLUMN live_game VARCHAR(255) DEFAULT NULL;
> ```

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
| `TWITCH_CHANNELS`       | ✅ | Comma-separated channel names |
| `TIKTOK_CHANNELS`       | ❌ | Comma-separated usernames (@ optional) |
| `TIKTOK_SIGN_API_KEY`   | ❌ | From eulerstream.com, improves reliability |
| `DB_HOST`               | ✅ | Default: localhost |
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
| `TWITCH_EVENTSUB_REDIRECT_URL` | ❌ | Callback URL for Twitch OAuth in web panel (e.g. `http://localhost:3000/admin/streams/twitch-auth/callback`). Must also be registered in the Twitch Developer Console. Optional — only needed to use the in-panel Twitch auth flow. |

---

## Access Levels

| Value | Name    | Permissions |
|-------|---------|-------------|
| 0     | User    | View dashboard only |
| 1     | Mod     | View dashboard + join/leave voice channel |
| 2     | Manager | View dashboard + user list + join/leave voice + stream monitor management |
| 3     | Admin   | Full access: add/update/remove users + Twitch OAuth + all above |

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

### Exported Discord client
`src/discordBot.ts` exports `discordClient: Client | null`. It is `null` until the `ready` event fires, then set to the live `Client` instance. Other modules (e.g. `src/web/routes/api.ts`) import this to call Discord APIs without holding a circular reference to the full bot module.

### Voice join/leave from web panel
`audioPlayer.ts` exports both `connect(client)` (join) and `disconnect()` (leave). `POST /api/voice/join` and `POST /api/voice/leave` in `src/web/routes/api.ts` are guarded by `requireMod` (access level ≥ 1). The dashboard shows a **Join Voice** / **Leave Voice** toggle button to Mod+ users; the button label and state are kept in sync by `applyStatus()` on every poll.

### Auth
`passport` and `passport-discord` were **not used** — they are deprecated. Discord OAuth2 is implemented directly in `src/web/routes/auth.ts` using `fetch` calls to the Discord API.

### dotenv override
`config.ts` uses `dotenv.config({ override: true })` to ensure `.env` values always take precedence over any system/user environment variables with the same name.

### Session augmentation
`src/types/express.d.ts` augments `express-session`'s `SessionData` interface (not the `Express` namespace) to add `user?: SessionUser` and `oauthState?: string`. `tsconfig.json` has `"ts-node": { "files": true }` so ts-node loads this ambient declaration.

### Voice adapter (custom raw gateway adapter)
`guild.voiceAdapterCreator` is **not used**. Instead, `audioPlayer.ts` builds a custom `DiscordGatewayAdapterCreator` that listens to `client.on('raw', ...)` and manually forwards `VOICE_STATE_UPDATE` and `VOICE_SERVER_UPDATE` packets to `@discordjs/voice`. This is required because the built-in adapter has type/version incompatibilities with discord.js v14.

### DAVE E2EE voice protocol
Discord requires the DAVE (E2EE) protocol for voice connections. `@discordjs/voice` dev branch (`1.0.0-dev.*`) handles this automatically when `@snazzah/davey` is installed. **The endpoint passed to `@discordjs/voice` must include the port** (e.g. `c-lhr16.discord.media:2096`) — do **not** strip the port. The voice WebSocket server lives on port 2096, not 443; stripping the port would cause the connection to fail after Hello.

### TikTok reconnect dedup
`tiktokBot.ts` uses a per-connection `reconnectScheduled` boolean to prevent duplicate `setTimeout` calls when both `STREAM_END` and `DISCONNECTED` fire for the same connection.

### MySQL tinyint(1) / bit columns returned as Buffer
MariaDB (and some MySQL configs) return `tinyint(1)` columns as a single-byte `Buffer` rather than `0`/`1`. All boolean reads in `db.ts` use the pattern:
```ts
Buffer.isBuffer(row.hidden) ? row.hidden[0] === 1 : row.hidden == 1
```
Apply this same pattern whenever reading any boolean/tinyint column.

### Session cookie in production
`src/web/server.ts` sets `cookie: { secure: false }`. Behind an HTTPS reverse proxy (e.g. nginx with `certbot`), change this to `secure: true` and add `app.set('trust proxy', 1)` so Express trusts the `X-Forwarded-Proto` header.

### Twitch stream monitor — polling-based
`twitchMonitor.ts` uses **polling** (every 60 s via `setInterval`) rather than EventSub WebSocket subscriptions. `getStreams()` is called on each poll tick; the module keeps an in-memory `liveStates` map and reconciles against the Helix response to detect go-live, game-change, and go-offline events.

### Twitch stream monitor — Discord posts vs tracking
`getMonitorEnabled()` (from `monitorSettings.ts`) controls **whether Discord messages are posted or edited** only. Stream tracking (the in-memory `liveStates` map + DB state) continues regardless of the toggle. Toggling ON calls `catchUpDiscordPosts()` which posts/edits Discord messages for all currently-tracked live streams.

### Twitch stream monitor — offline grace period
When a stream appears offline in a poll, `handleStreamOffline()` starts a 5-minute `setTimeout` before confirming offline and deleting the Discord announcement. If the stream comes back within that window (e.g. a brief outage) the timer is cancelled and no changes are made to Discord.

### Twitch stream monitor — startup live-check
On `startTwitchMonitor()`, after loading streamers from DB, `performStartupLiveCheck()` is called. It queries Helix for all monitored user IDs and reconciles against the stored `discord_message_id`/`live_game` columns: live + has message → edit; live + no message → post fresh; offline + has message → delete and clear DB; offline + no message → no-op.

### Twitch stream monitor — multitwitch
When ≥2 streamers in the same group are live on the same game, each matching Discord embed gets a footer built from `group.multi_twitch_message` with `{multitwitch}` replaced by `https://www.multitwitch.tv/login1/login2/...`. `updateMultitwitch(groupId)` is called after any live-state change (go-live, game-change, go-offline).

### Twitch stream monitor — hot reload
Any CRUD change to groups or streamers via the web panel calls `restartTwitchMonitor()` which tears down the poll timer, clears in-memory state, and re-runs `startTwitchMonitor()` (including startup live-check). Existing Discord messages are NOT deleted on restart; the live-check will re-sync them.

### Twitch stream monitor — process exit
`index.ts` calls `stopTwitchMonitor()` on `SIGINT`/`SIGTERM`. This stops the poll timer and clears in-memory state **without deleting Discord announcement messages** — they are left in place so the startup live-check on the next boot can re-sync them. `shutdownTwitchMonitor()` (which does delete all messages) is intentionally not used on process exit.

### Twitch stream monitor — EventSub token (stored but not yet wired)
The Twitch OAuth flow at `/admin/streams/twitch-auth` stores a user access token in `monitor-settings.json` via `setEventSubToken()`. The current `twitchMonitor.ts` implementation does not use this token — it relies on an app (client credentials) token from `twitchApi.ts`. The stored token is reserved for future EventSub WebSocket subscriptions.

### monitor-settings.json
Local file (`monitor-settings.json` at `process.cwd()`) persists two values: `twitchMonitorEnabled` (boolean, default `true` if file missing) and `eventSubToken` (string, optional). It is **gitignored**. Read/write via `src/monitorSettings.ts` helpers only.

---

## Scripts

```bash
npm run dev      # ts-node src/index.ts (development)
npm run build    # tsc → dist/
npm start        # node dist/index.js (production)
```

---

## Package Notes

- `@discordjs/voice` is the **dev branch** build (`1.0.0-dev.*`) — required for DAVE E2EE protocol support.
- `@snazzah/davey` is the DAVE protocol library auto-used by `@discordjs/voice` dev for E2EE voice handshake.
- `opusscript` is the pure-JS Opus encoder used by `@discordjs/voice`.
- `ffmpeg-static` provides the ffmpeg binary for audio transcoding.
- `"overrides": { "undici": "^7.22.0" }` in `package.json` resolves an indirect vulnerability from older `undici` pulled in by other packages.
- `npm audit` should report **0 vulnerabilities**.
- TypeScript: `npx tsc --noEmit` should produce **no output** (clean).

---

## Web Panel Routes

| Method | Path                    | Guard       | Description |
|--------|-------------------------|-------------|-------------|
| GET    | `/auth/login`           | —           | Login page  |
| GET    | `/auth/discord`         | —           | Start OAuth2 flow |
| GET    | `/auth/discord/callback`| —           | OAuth2 callback |
| GET    | `/auth/logout`          | —           | Destroy session |
| GET    | `/`                     | requireAuth | Dashboard |
| GET    | `/api/status`           | requireAuth | JSON status snapshot |
| POST   | `/api/voice/join`       | Mod+        | Join configured voice channel |
| POST   | `/api/voice/leave`      | Mod+        | Leave voice channel |
| GET    | `/admin/users`          | Manager+    | User list |
| POST   | `/admin/users/add`      | Admin       | Add/update user |
| POST   | `/admin/users/update`   | Admin       | Change access level |
| POST   | `/admin/users/remove`   | Admin       | Remove user |
| GET    | `/admin/streams`        | Manager+    | Stream monitor management page |
| GET    | `/admin/streams/live`   | Manager+    | JSON snapshot of currently live streams |
| POST   | `/admin/streams/toggle` | Manager+    | Enable/disable Discord announcements |
| GET    | `/admin/streams/twitch-auth` | Admin  | Start Twitch OAuth2 flow |
| GET    | `/admin/streams/twitch-auth/callback` | Admin | Twitch OAuth2 callback |
| POST   | `/admin/streams/groups/add`    | Manager+ | Add stream group |
| POST   | `/admin/streams/groups/update` | Manager+ | Update stream group |
| POST   | `/admin/streams/groups/remove` | Manager+ | Remove stream group (and its streamers) |
| POST   | `/admin/streams/streamers/add`    | Manager+ | Add streamer to group |
| POST   | `/admin/streams/streamers/remove` | Manager+ | Remove streamer |

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

## `db.ts` Query Functions

- `findTrigger(command)` — looks up an `sfxtrigger` row by its full command string (case-insensitive); includes hidden triggers (hidden = listing-only flag, not a playback gate)
- `findSoundFiles(triggerId)` — returns all `sfx` rows for a trigger including hidden ones; used by `commandRouter.ts`
- `getAllSfxTriggers()` — **dashboard aggregate**: single JOIN query across `sfxtrigger`, `sfxcategory`, and `sfx`; returns `SfxTriggerRow[]` where each entry has a `files[]` array already grouped
- `findUser(discordId)` / `getAllUsers()` — user lookups for auth and admin panel
- `upsertUser(discordId, discordName, accessLevel)` — INSERT … ON DUPLICATE KEY UPDATE
- `updateAccessLevel(discordId, accessLevel)` / `removeUser(discordId)` — admin mutations
- `AccessLevel` const object (`USER=0 MOD=1 MANAGER=2 ADMIN=3`) and `AccessLevelValue` type are exported from `db.ts` — use these instead of raw numbers
- `getAllStreamersWithGroups()` — JOIN query returning `DbStreamerFull[]` (each row includes full `DbStreamGroup` as `.group`); used by `twitchMonitor.ts`
- `getAllStreamGroups()` — returns all `stream_group` rows as `DbStreamGroup[]`
- `getAllStreamers()` — returns all streamers with `group_name` joined; used by web panel
- `addStreamGroup()` / `updateStreamGroup()` / `removeStreamGroup()` — stream group CRUD
- `addStreamer(name, groupId)` / `removeStreamer(id)` / `removeStreamersByGroup(groupId)` — streamer CRUD
- `setStreamerLive(id, messageId, channelId, game)` — update `discord_message_id`, `discord_channel_id`, `live_game` on a streamer row
- `clearStreamerLive(id)` — null out all three live columns on a streamer row
- `DbStreamGroup` and `DbStreamerFull` interfaces exported from `db.ts`

> **Note:** State is lost on process restart. Sessions are also in-memory (no persistent session store configured).

---

## Potential Future Work

- Persistent sessions (e.g. `connect-session-sequelize` or `express-mysql-session`)
- Ability to create/edit/hide SFX triggers from the web panel
- Bot activity log / recent commands on dashboard
- Twitch channel points reward handling (currently only chat commands)
- Docker / PM2 deployment config
