# BCUK Bot 4

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Battle-Cattle/BCUK-Bot-4)
[![Maintainability](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4/maintainability.svg)](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4)
[![Code Coverage](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4/coverage.svg)](https://qlty.sh/gh/Battle-Cattle/projects/BCUK-Bot-4)

A multi-platform community bot connecting Twitch, Discord, and TikTok Live. Features custom commands, soundboard effects, counters, and a web control panel.

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
