# `src/db/` — database layer rules

Loaded when working in `src/db/`. The repo-wide rules (import from `src/db.ts` only, BIGINT columns are strings, migrations are never edited) are in the root `CLAUDE.md`.

## Layout

One module per domain (`users.ts`, `guilds.ts`, `customCommands.ts`, `counters.ts`, `sfx.ts`, `streamMonitor.ts`, `eventSub.ts`, …), each with a co-located `*.test.ts`. Writes to cached tables get a cache-invalidating `*Writes.ts` wrapper module (`userWrites.ts`, `customCommandWrites.ts`, `counterWrites.ts`, `sfxWrites.ts`, …, built on `withInvalidation.ts`) that `src/db.ts` re-exports in place of the raw write. `src/db.ts` itself is pure re-exports, and `src/db.test.ts` checks that every wrapper is the one exported.

**`customCommands.ts` does not own its cache:** it's a pure DB layer with no cache knowledge, to break its import cycle with `customCommandCache.ts`. `customCommandWrites.ts` owns invalidation instead, via `withInvalidation()`-wrapped write functions that call `invalidateCustomCommandLookupCache()` after the underlying `customCommands.ts` write succeeds (same pattern for `counters.ts`/`alertConfig.ts`/`sfx.ts` via `counterWrites.ts`/`alertConfigWrites.ts`/`sfxWrites.ts`). Don't add a second invalidation call inside `customCommands.ts` itself.

## SQL

- **BIGINT columns are strings** (`bigNumberStrings: true` on the pool). This protects against precision loss on values that can exceed `Number.MAX_SAFE_INTEGER`, like Discord snowflakes. It does not apply to a BIGINT result you can prove is bounded well within that range (e.g. `COUNT(*)` on a small admin table); if you parse one of those back to a number, say at the call site why this value is bounded. See `getRowCount` in `src/db/utils.ts` for the pattern.
- **Blank Twitch names → `NULL`** — `user.twitch_name` has a unique index; empty strings collide.
- **MySQL 8 upsert:** row-alias form only, `VALUES (...) AS new_row`. The deprecated `VALUES(col)` is not used.
- **`mutationQueue`** for concurrent-unsafe writes — user mutations serialise through it via `runUserMutation` in `src/shared/userMutationQueue.ts`.

## Migrations

The bot applies pending `migrations/NNNN_*.sql` files on startup (`src/db/migrations.ts`, tracked in `schema_migrations`; see the README's "Database migrations"). `0001_baseline.sql` is the full schema at the switch. Any schema change is a new numbered file plus a matching `DATABASE-SCHEMA.md` update (a test replays the migrations against the doc). Never edit an applied migration — startup fails on a checksum mismatch. A deploy that brings new migrations and then fails its health check doesn't roll back automatically (the previous build refuses to start against a migration it has no file for, and a migration that failed part way leaves unrecorded DDL behind), so `deploy.sh` stops and prints the manual steps, starting with the database backup it takes before every restart (`scripts/backup-db.sh`).

## Database tests

`npm run test:db` runs the `*.db.test.ts` files against MySQL 8.4.11 from `docker-compose.test-db.yml` (needs `TEST_DB_*`; see the README's "Database tests"). It covers what the mocked-pool tests can't: foreign-key actions, unique-index errors and the migrations themselves. Behaviour that only a real database shows goes in a `*.db.test.ts` next to the module. Run it locally if you change a migration or a DB module's SQL and Docker is available; otherwise leave it to CI.
