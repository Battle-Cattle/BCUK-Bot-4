# `src/web/` — web panel rules

Loaded when working in `src/web/`. The repo-wide rules are in the root `CLAUDE.md`.

## Web Server (`src/web/server.ts`)

Middleware order: `helmet` (custom CSP) → `GET /healthz` → EJS views → static → body parsers → `trust proxy: 1` → `preSessionLimiter` (coarse per-IP cap, so a replayed session cookie can't hit the session store unthrottled) → session (`express-mysql-session`, backed by the `sessions` MySQL table, on its own bounded pool from `getSessionPool`; a full queue answers 503) → `enforceSessionLifetime` (`src/web/sessionLifetime.ts`: a session lasts 24h since its last page load, renewed only by `Sec-Fetch-Mode: navigate` requests, and at most 7 days since login) → rate limiters (general/overlay/session; `streamdeckLimiter` is applied per-route instead. An OBS overlay's own requests (`isOverlayTraffic` in `src/web/overlayTraffic.ts`: event streams, file downloads, the shared overlay's reports) skip the general limiter and get `overlayTrafficLimiter`) → `res.locals.user`/csrfToken → feature routes (`mountRoutes` in `src/web/routes/index.ts`, which keeps their mount order) → 404 and error handlers. The general/session rate limiters run after session middleware deliberately — `sessionLimiter`'s key generator needs `req.session` populated.

**`GET /healthz`** answers once the web panel is listening, which `main()` reaches only after the DB ping, guild registry and bot startup. `deploy.sh` polls it after restarting the service, then checks the bot stays up for 30s; if either fails it rolls back to the previous build (see the README's "Deployment"). Keep it unauthenticated, ahead of the session and rate-limit middleware, and free of any detail beyond "ok".

Auth middleware (`src/web/middleware.ts`), applied in this order:
1. **`requireAuth`** — session check.
2. **`requireGuildContext`** — re-derives the user's access level from the DB for the active guild on every request. **Must run before any `requireAccessLevel` check** — skipping it leaves a stale or absent access level that could bypass a mod/manager/admin gate.
3. **`requireAccessLevel(level)`** factory → `requireMod`/`requireManager`/`requireAdmin`.
4. **`requireOwner`** — separate global super-admin check via `is_owner`, not part of the `AccessLevel` ladder.
5. **`authenticateBearerToken()`** factory → `requireApiKey` (Streamdeck) / `requireCompanionKey` (companion app), for API routes that bypass session auth entirely.

**POST routes redirect to `?error=code`** on failure; GET reads it and passes it to EJS. Never render errors from a POST handler.

## Access Levels

0=User, 1=Mod (+voice), 2=Manager (+user list, streams/commands/counters/SFX), 3=Admin (full). Use `AccessLevel` const from `src/db/users.ts` — not raw numbers. Manager+ = ≥ 2.

**Custom Commands exception:** any user with a linked Twitch account can manage the commands on their own channel. They can add Twitch-only commands, edit/delete commands assigned to them alone, and remove themselves from shared ones. Mod+ manage the whole catalog: Discord/multi-Twitch flags, assignments and server overrides. The rules live in `src/web/routes/commandPermissions.ts`; the Mod+ catalog check, assignee lookup and new-entry assignee rule shared with Timers live in `src/web/routes/selfServiceAccess.ts`.

**Timers exception:** the same self-service model applies to Timers. A user with a linked Twitch account can add timers to their own channel, edit/toggle/delete timers assigned to them alone, and remove themselves from shared ones. Mod+ manage the whole catalog and its assignments. The rules live in `src/web/routes/timerPermissions.ts` (plus the shared `selfServiceAccess.ts`), and streamer writes go through the owner-checked `*OwnTimerCommand*` DB functions.

**Advanced Commands:** per-streamer and self-service only — no catalog, assignments or Mod+ override. Every route resolves the session user's (or the Stream Deck/companion key owner's) streamer record, and every DB function is scoped by `streamer_id`. The DB layer is `src/db/advancedCommand*.ts`, the runtime (gates, effects, companion acknowledgements and refunds) is `src/commands/advancedCommands/`, and the use ledger `advanced_command_usage` makes a refund happen at most once.
