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
3. Swaps the new build in, keeping the previous one (and, if the dependencies changed, the previous `node_modules`) beside it.
4. Backs up the database (see [Backups](#backups)).
5. Restarts the service.
6. Waits up to 90 seconds for `GET /healthz` on the web panel to answer from the service's own process, then 30 more to check it stays up: the same process, no restarts, still answering.

If any step fails, the deploy rolls back: the previous code, build and dependencies go back in place and, if the service had already restarted, it restarts onto the previous build and checks that comes up. It then prints a report, also saved to `logs/last-deploy-failure.log`: what failed, the command, both commits, the service status and its log since the restart, and whether the rolled-back bot is healthy. A failed rollback says so in capitals: the bot is down.

One case doesn't roll back automatically: when the failed build had already applied a new database migration. The previous build refuses to start against a database that records migrations it doesn't know, so the deploy leaves the new build in place and prints the commands to go back by hand, starting with restoring the backup it took just before the restart. Fixing forward is usually quicker.

The backup is required when a deploy adds migrations; otherwise a failed backup only warns. The health check needs `curl` and `ss` (from iproute2); the backup needs `mysqldump`, and the migration check `mysql` (both from `mysql-client`).

Day to day:

```bash
systemctl status bcuk-bot        # running?
journalctl -u bcuk-bot -f        # follow the logs (the bot also writes logs/ as before)
sudo systemctl restart bcuk-bot  # manual restart
```

### Debug logging

The bot writes `logs/combined-YYYY-MM-DD.log` (at `LOG_LEVEL`, info by default in production) and `logs/error-YYYY-MM-DD.log`. Debug lines go to their own file, `logs/debug-YYYY-MM-DD.log`, and only while debug logging is switched on. It switches itself off after a set time, at most 72 hours, and a restart in the meantime keeps it on. Two ways to turn it on:

- **Health page:** `/admin/health` (owner only). Pick 1, 6, 24 or 72 hours and press **Turn on**. It takes effect immediately, with no restart. The page shows when it ends and has a **Turn off now** button.
- **With a deploy:** `npm run deploy debug` turns it on for 24 hours from the restart; `npm run deploy debug 6` for 6.

While it's on, the debug file holds info, warning and error lines as well, so it reads on its own. Debug files are deleted after 3 days, whether or not debug logging is on.

## Database migrations

The bot keeps the schema up to date itself. On every start, after checking it can reach the database and before anything else, it applies each file in `migrations/` that the `schema_migrations` table doesn't record yet, in order, and records it. A named lock stops two processes migrating at once. If a migration fails, the bot logs which one and exits, so a deploy fails its health check instead of running against a half-upgraded schema.

`migrations/0001_baseline.sql` is the full schema from when this was introduced. An empty database runs it. A database that already had the tables but no `schema_migrations` table records it as applied without running it, after checking every baseline table is there.

A database that has some tables but not every one the baseline creates is a partial schema: the bot refuses to start against it rather than adopt it. Don't run `0001_baseline.sql` against one either: its `CREATE TABLE IF NOT EXISTS` statements skip tables that already exist in an older shape, which hides the gap instead of fixing it.

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

### Backups

`bash scripts/backup-db.sh [label]` dumps the database (`mysqldump --single-transaction`, which doesn't lock the running bot out) to a gzipped file in `BACKUP_DIR` (default `~/bcuk-bot-backups`) and deletes the oldest beyond `BACKUP_KEEP` (default 14). `deploy.sh` runs it with the label `pre-deploy` before every restart. For a nightly backup too, add a cron entry for the bot's user (`crontab -e`):

```
17 4 * * * cd /path/to/BCUK-Bot-4 && bash scripts/backup-db.sh nightly > /dev/null
```

Treat dumps as secrets: they hold every stored OAuth token, encrypted with `EVENTSUB_TOKEN_SECRET`, and the directory and files are created readable by the bot's user only. Back up separately, and somewhere other than this server:

- **`.env`**, above all `EVENTSUB_TOKEN_SECRET` (without it, restored tokens can't be decrypted and every streamer has to reconnect) and `SESSION_SECRET`.
- **The upload folders** (`OVERLAY_FOLDER`, `ALERT_ASSETS_FOLDER`, `SFX_FOLDER`), which the database rows point at, e.g. `tar czf uploads-$(date +%F).tar.gz <folders>`.
- **The dumps themselves**: a copy on the same disk doesn't survive losing the disk.

**Restoring.** `bash scripts/restore-db.sh <dump.sql.gz>` replaces the live database. It refuses while the service is running and asks you to type the database name to confirm. Before it changes anything it saves the current data as a `pre-restore` dump (and stops if that fails); it prints the file's path, which you can restore the same way to undo it:

```bash
sudo systemctl stop bcuk-bot
bash scripts/restore-db.sh ~/bcuk-bot-backups/<file>.sql.gz
sudo systemctl start bcuk-bot
```

**Test a backup** now and then by restoring it into a scratch database, which leaves the live one alone: `bash scripts/restore-db.sh <file> bcuk_restore_test`. If that database already has tables (a name reused or mistyped), it asks you to type the name first, since restoring drops them all. Then check it looks right, logging in as the bot's database user (`DB_HOST`, `DB_PORT` and `DB_USER` in `.env`, with 3306 for an unset port; `-p` asks for `DB_PASSWORD`): `mysql -h <DB_HOST> -P <DB_PORT> -u <DB_USER> -p bcuk_restore_test -e 'SELECT COUNT(*) FROM user; SELECT version FROM schema_migrations'`. Drop it afterwards the same way: `mysql -h <DB_HOST> -P <DB_PORT> -u <DB_USER> -p -e 'DROP DATABASE bcuk_restore_test'`. The bot's MySQL user needs the `CREATE` and `DROP` privileges on that database.

### SFX file format

Any format ffmpeg reads will play, but each play of most formats starts an ffmpeg process to decode and re-encode it, which adds a short delay before the sound is heard. A file that's already **48kHz stereo Opus in an `.ogg`, `.opus` or `.webm` file** goes to Discord as it is, with no ffmpeg step, so it starts fastest. To convert one (any other kind of `.ogg`, such as Vorbis or mono Opus, still plays through ffmpeg):

```bash
ffmpeg -i airhorn.mp3 -c:a libopus -b:a 96k -ar 48000 -ac 2 airhorn.ogg
```

A converted file is a new filename, so re-upload it on the SFX page (or update the `sfx.file` row) and remove the old one.
