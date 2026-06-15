#!/usr/bin/env bash
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
# Name of the screen session the bot runs in.
SCREEN_SESSION="BCUK"
# ─────────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")"

[ -f package.json ] || { echo "ERROR: Run this script from the repo root."; exit 1; }

PREVIOUS_SHA=$(git rev-parse HEAD)

# On any error after git pull, roll back to the previous commit.
rollback() {
    echo "ERROR: Deployment failed. Rolling back to $PREVIOUS_SHA..."
    git reset --hard "$PREVIOUS_SHA"
    exit 1
}

echo "==> Pulling latest code..."
if ! git diff-index --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    echo "ERROR: Working directory has uncommitted changes or untracked files."
    echo "       Commit or stash changes before deploying."
    exit 1
fi
git pull origin main

trap rollback ERR

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

trap - ERR  # Rollback no longer needed — code is good.

echo "==> Restarting bot in screen session '$SCREEN_SESSION'..."
if screen -list | grep -Eq "[0-9]+\.${SCREEN_SESSION}[[:space:]]"; then
    screen -S "$SCREEN_SESSION" -X stuff $'\003'

    # Wait up to 15s for the node process to fully exit before restarting.
    for _ in {1..15}; do
        pgrep -f "node dist/index.js" > /dev/null 2>&1 || break
        sleep 1
    done

    if pgrep -f "node dist/index.js" > /dev/null 2>&1; then
        echo "WARNING: Node process did not stop within 15s. Attempting restart anyway..."
    fi

    screen -S "$SCREEN_SESSION" -X stuff "npm start\n"
    echo "==> Bot restarted."
else
    echo "WARNING: Screen session '$SCREEN_SESSION' not found."
    echo "         Start it manually: screen -S $SCREEN_SESSION npm start"
fi

echo "==> Deploy complete."
