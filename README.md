# BCUK Bot 4

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Battle-Cattle/BCUK-Bot-4)
[![Maintainability](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4/maintainability.svg)](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4)
[![Code Coverage](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4/coverage.svg)](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4)
![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/Battle-Cattle/BCUK-Bot-4?utm_source=oss&utm_medium=github&utm_campaign=Battle-Cattle%2FBCUK-Bot-4&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)

A multi-platform community bot connecting Twitch and Discord. Features custom commands, soundboard effects, counters, viewer loyalty points (chat-earn, sub bonuses, `!gamble`, `!raffle`), and a web control panel.

## Requirements

- **Node.js 24.22.1 or later**, matching `engines` in `package.json` and CI. `.npmrc` sets `engine-strict=true`, so `npm install`/`npm ci` (and so `deploy.sh`) stop on an older Node. Use the npm 11 that Node 24 ships with: npm 10 has failed `npm ci` on this lockfile with a spurious `Missing: <pkg> from lock file` error (it handles the `overrides` entries differently), so check `npm -v` if you installed npm separately.
- **MySQL 8.0.19 or later.** Upserts use the `INSERT … VALUES (…) AS new_row` row-alias form, which older versions reject. For a fresh install, create an empty `utf8mb4` database: the bot creates the tables on first start (see [Database migrations](#database-migrations)). `DATABASE-SCHEMA.md` documents each table.
- A `.env` file with credentials for each platform. Copy `.env.example` and fill it in; it lists every setting the bot reads.

> **Dev environment note:** The `.env` file is the single source of truth for local configuration. dotenv only fills variables that are not already set in the environment — it does **not** override them. If you have any of the bot's variables exported in your shell profile (e.g. `~/.bashrc`, `~/.zshrc`), un-export or remove those entries so the `.env` values are used instead.

## Usage

```bash
npm install
npm run dev      # development
npm run build    # compile TypeScript
npm start        # production
```

## Running the bot

In production the bot runs as a systemd service, `bcuk-bot`. systemd restarts it 10 seconds after a crash and starts it on boot. It never stops retrying, so the bot comes back by itself after a database or network outage. Repeated failures back off to one attempt every 5 minutes (on systemd 254+), so a long outage doesn't hammer the Discord and Twitch logins.

One-time setup, run on the server as the user the bot should run as (not root):

```bash
bash scripts/install-systemd-service.sh
```

This installs and enables the unit from `deploy/bcuk-bot.service`, filled in with your user, this checkout's path and your `node`. It also adds a sudoers rule allowing that user to run `systemctl restart bcuk-bot` and nothing else. It doesn't start the service: stop any copy still running elsewhere first (for example in an old `screen` session), then run `sudo systemctl start bcuk-bot`.

The unit keeps running the `node` it was installed with, so after upgrading Node, re-run `bash scripts/install-systemd-service.sh` (it rewrites the unit with the `node` now on your `PATH`) and then deploy. `deploy.sh` checks that the service's `node` meets `engines` in `package.json` and stops before installing anything if it doesn't.

`bash deploy.sh` (or `npm run deploy`) then:

1. Pulls the latest code.
2. Builds and tests it.
3. Swaps the new build in.
4. Restarts the service.
5. Waits up to 90 seconds for `GET /healthz` on the web panel to answer from the service's own process.

If the bot doesn't come back up, the deploy fails and prints the service status and its last 50 log lines. It also fails straight away if another process holds the web port, such as a copy still running in an old `screen` session. The health check needs `curl` and `ss` (from iproute2).

Day to day:

```bash
systemctl status bcuk-bot        # running?
journalctl -u bcuk-bot -f        # follow the logs (the bot also writes logs/ as before)
sudo systemctl restart bcuk-bot  # manual restart
```

## Database migrations

The bot keeps the schema up to date itself. On every start, after checking it can reach the database and before anything else, it applies each file in `migrations/` that the `schema_migrations` table doesn't record yet, in order, and records it. A named lock stops two processes migrating at once. If a migration fails, the bot logs which one and exits, so a deploy fails its health check instead of running against a half-upgraded schema.

`migrations/0001_baseline.sql` is the full schema from when this was introduced. An empty database runs it. A database that already had the tables but no `schema_migrations` table records it as applied without running it, after checking every baseline table is there.

### Upgrading a database from before the baseline

The per-feature upgrade scripts that came before the baseline were removed from `migrations/`; they live in git history at commit `b80b81d`. A database older than the baseline fails that check at startup with "missing baseline tables (…)", and the bot doesn't start until it's brought up to date by hand:

1. List the old scripts with `git ls-tree --name-only b80b81d migrations/`, and print one with `git show b80b81d:migrations/<name>.sql`.
2. Apply each script your database hasn't had yet, reading its header first: some need settings filled in (`multi_guild.sql` needs `@legacy_guild_id` set to your `DISCORD_GUILD_ID`).
3. Compare against `migrations/0001_baseline.sql` (and `DATABASE-SCHEMA.md`) until every table and column it creates is present, then start the bot. It records the baseline as applied and carries on from there.

Don't run `0001_baseline.sql` against a partial schema: its `CREATE TABLE IF NOT EXISTS` statements skip tables that already exist in an older shape, which hides the gap instead of fixing it.

To change the schema:

1. Add `migrations/NNNN_short_description.sql`, numbered one past the highest existing file (four digits, lowercase and underscores).
2. Update `DATABASE-SCHEMA.md` to match. A test replays the migrations and checks the doc lists the same tables and columns; spell column changes as `ADD COLUMN`/`DROP COLUMN`/`RENAME COLUMN`/`CHANGE COLUMN` so it can follow them.
3. Never edit or rename a migration once it has been applied anywhere: startup fails if an applied file's checksum changes. Fix mistakes with a new migration.

MySQL commits each DDL statement on its own, so a migration that fails part-way can't be rolled back, and systemd will keep retrying it on restart. Prefer one change per file, and make statements safe to re-run where you can: `CREATE TABLE IF NOT EXISTS` works, but MySQL has no `ADD COLUMN IF NOT EXISTS`, so check `information_schema` in a prepared statement when it matters. To recover, stop the service, finish or undo the failed file's changes by hand, fix the file (it isn't recorded until it succeeds), and start again.

## Deployment

The web panel serves uploaded files straight from disk: overlay videos from `OVERLAY_FOLDER`, alert images and sounds from `ALERT_ASSETS_FOLDER`, and sounds from `SFX_FOLDER`. The bot checks every served path stays inside its folder, following symlinks, but the check can't be atomic with the file read. So:

- Make these folders owned and writable **only** by the user the bot runs as (e.g. `chown -R bot:bot <folder> && chmod -R go-w <folder>`). Anyone else who can write there could plant a symlink to a file outside the folder and race the check.
- Don't point them at a shared or world-writable location (e.g. `/tmp`), and don't nest one inside a directory other users can write to.
- Keep them outside the repo checkout and away from `.env` and other secrets.

### SFX file format

Any format ffmpeg reads will play, but each play of most formats starts an ffmpeg process to decode and re-encode it, which adds a short delay before the sound is heard. A file that's already **48kHz stereo Opus in an `.ogg`, `.opus` or `.webm` file** goes to Discord as it is, with no ffmpeg step, so it starts fastest. To convert one (any other kind of `.ogg`, such as Vorbis or mono Opus, still plays through ffmpeg):

```bash
ffmpeg -i airhorn.mp3 -c:a libopus -b:a 96k -ar 48000 -ac 2 airhorn.ogg
```

A converted file is a new filename, so re-upload it on the SFX page (or update the `sfx.file` row) and remove the old one.
