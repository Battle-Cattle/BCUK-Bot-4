# BCUK Bot 4

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Battle-Cattle/BCUK-Bot-4)
[![Maintainability](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4/maintainability.svg)](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4)
[![Code Coverage](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4/coverage.svg)](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4)
![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/Battle-Cattle/BCUK-Bot-4?utm_source=oss&utm_medium=github&utm_campaign=Battle-Cattle%2FBCUK-Bot-4&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)

A multi-platform community bot connecting Twitch and Discord. Features custom commands, soundboard effects, counters, viewer loyalty points (chat-earn, sub bonuses, `!gamble`), and a web control panel.

## Requirements

- **Node.js 24 or later**, matching `engines` in `package.json` and CI. Use the npm 11 that Node 24 ships with: npm 10 has failed `npm ci` on this lockfile with a spurious `Missing: <pkg> from lock file` error (it handles the `overrides` entries differently), so check `npm -v` if you installed npm separately.
- **MySQL 8.0.19 or later.** Upserts use the `INSERT … VALUES (…) AS new_row` row-alias form, which older versions reject. For a fresh install, create the tables from `schema.sql` (`migrations/` upgrades an existing one); `DATABASE-SCHEMA.md` documents each table.
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

In production the bot runs as a systemd service, `bcuk-bot`. systemd restarts it within a few seconds after a crash and starts it on boot. It gives up after five failed starts in five minutes, so a broken config can't put it in a crash loop.

One-time setup, run on the server as the user the bot should run as (not root):

```bash
bash scripts/install-systemd-service.sh
```

This installs and enables the unit from `deploy/bcuk-bot.service`, filled in with your user, this checkout's path and your `node`. It also adds a sudoers rule allowing that user to run `systemctl restart bcuk-bot` and nothing else. It doesn't start the service: stop any copy still running elsewhere first (for example in an old `screen` session), then run `sudo systemctl start bcuk-bot`.

`bash deploy.sh` (or `npm run deploy`) then:

1. Pulls the latest code.
2. Builds and tests it.
3. Swaps the new build in.
4. Restarts the service.
5. Waits up to 90 seconds for `GET /healthz` on the web panel to answer.

If the bot doesn't come back up, the deploy fails and prints the service status and its last 50 log lines.

Day to day:

```bash
systemctl status bcuk-bot        # running?
journalctl -u bcuk-bot -f        # follow the logs (the bot also writes logs/ as before)
sudo systemctl restart bcuk-bot  # manual restart
```

## Deployment

The web panel serves uploaded files straight from disk: overlay videos from `OVERLAY_FOLDER`, alert images and sounds from `ALERT_ASSETS_FOLDER`, and sounds from `SFX_FOLDER`. The bot checks every served path stays inside its folder, following symlinks, but the check can't be atomic with the file read. So:

- Make these folders owned and writable **only** by the user the bot runs as (e.g. `chown -R bot:bot <folder> && chmod -R go-w <folder>`). Anyone else who can write there could plant a symlink to a file outside the folder and race the check.
- Don't point them at a shared or world-writable location (e.g. `/tmp`), and don't nest one inside a directory other users can write to.
- Keep them outside the repo checkout and away from `.env` and other secrets.
