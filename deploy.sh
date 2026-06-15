#!/usr/bin/env bash
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
# Name of the screen session the bot runs in.
SCREEN_SESSION="BCUK"
# ─────────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")"

[ -f package.json ] || { echo "ERROR: Run this script from the repo root."; exit 1; }

echo "==> Pulling latest code..."
git pull origin main

echo "==> Installing dependencies..."
npm ci

echo "==> Checking for vulnerabilities..."
npm audit --audit-level=high

echo "==> Building..."
npm run build

echo "==> Running tests..."
npm test

echo "==> Pruning dev dependencies..."
npm prune --omit=dev

echo "==> Restarting bot in screen session '$SCREEN_SESSION'..."
if screen -list | grep -q "$SCREEN_SESSION"; then
    screen -S "$SCREEN_SESSION" -X stuff $'\003'
    sleep 2
    screen -S "$SCREEN_SESSION" -X stuff "npm start\n"
    echo "==> Bot restarted."
else
    echo "WARNING: Screen session '$SCREEN_SESSION' not found."
    echo "         Start it manually: screen -S $SCREEN_SESSION npm start"
fi

echo "==> Deploy complete."
