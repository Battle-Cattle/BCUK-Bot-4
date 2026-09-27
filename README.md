# BCUK Bot 4

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Battle-Cattle/BCUK-Bot-4)
[![Maintainability](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4/maintainability.svg)](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4)
[![Code Coverage](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4/coverage.svg)](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4)
![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/Battle-Cattle/BCUK-Bot-4?utm_source=oss&utm_medium=github&utm_campaign=Battle-Cattle%2FBCUK-Bot-4&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)

A multi-platform community bot connecting Twitch and Discord. Features custom commands, soundboard effects, counters, and a web control panel.

## Requirements

- Node.js, MySQL
- `.env` file with credentials for each platform

> **Dev environment note:** The `.env` file is the single source of truth for local configuration. dotenv only fills variables that are not already set in the environment — it does **not** override them. If you have any of the bot's variables exported in your shell profile (e.g. `~/.bashrc`, `~/.zshrc`), un-export or remove those entries so the `.env` values are used instead.

## Usage

```bash
npm install
npm run dev      # development
npm run build    # compile TypeScript
npm start        # production
```

## Deployment

The web panel serves uploaded files straight from disk: overlay videos from `OVERLAY_FOLDER`, alert images and sounds from `ALERT_ASSETS_FOLDER`, and sounds from `SFX_FOLDER`. The bot checks every served path stays inside its folder, following symlinks, but the check can't be atomic with the file read. So:

- Make these folders owned and writable **only** by the user the bot runs as (e.g. `chown -R bot:bot <folder> && chmod -R go-w <folder>`). Anyone else who can write there could plant a symlink to a file outside the folder and race the check.
- Don't point them at a shared or world-writable location (e.g. `/tmp`), and don't nest one inside a directory other users can write to.
- Keep them outside the repo checkout and away from `.env` and other secrets.
