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

# Retries a command up to 4 times with exponential backoff (2s, 4s, 8s, 16s),
# to ride out transient failures like registry/CDN timeouts (e.g. ffmpeg-static's
# postinstall download from GitHub releases).
retry() {
    local attempt=1
    local max_attempts=4
    local delay=2
    until "$@"; do
        if [ "$attempt" -ge "$max_attempts" ]; then
            echo "ERROR: '$*' failed after $max_attempts attempts."
            return 1
        fi
        echo "WARNING: '$*' failed (attempt $attempt/$max_attempts). Retrying in ${delay}s..."
        sleep "$delay"
        attempt=$((attempt + 1))
        delay=$((delay * 2))
    done
}

echo "==> Pulling latest code..."
git update-index -q --refresh
if ! git diff-index --quiet HEAD --; then
    echo "ERROR: Working directory has uncommitted changes or untracked files."
    echo "       Commit or stash changes before deploying."
    exit 1
fi
git pull origin main

trap rollback ERR

echo "==> Installing dependencies..."
retry npm ci

echo "==> Checking for vulnerabilities..."
npm audit --audit-level=high

echo "==> Building and running tests in parallel..."
# Tests import directly from src/*.ts (vitest transforms on the fly), not from
# dist/, so the build and test suite have no dependency on each other.
# Tests take longer, so their output streams live; the build finishes first
# and is captured to a log that gets dumped once it's done.
BUILD_LOG=$(mktemp)
trap 'rm -f "$BUILD_LOG"' EXIT

npm run build > "$BUILD_LOG" 2>&1 &
BUILD_PID=$!
npm test &
TEST_PID=$!

BUILD_STATUS=0
TEST_STATUS=0
wait "$BUILD_PID" || BUILD_STATUS=$?

echo "--- Build output ---"
cat "$BUILD_LOG"

wait "$TEST_PID" || TEST_STATUS=$?

if [ "$BUILD_STATUS" -ne 0 ] || [ "$TEST_STATUS" -ne 0 ]; then
    rollback
fi

echo "==> Pruning dev dependencies..."
npm prune --omit=dev

trap - ERR  # Rollback no longer needed — code is good.

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Restarting bot in screen session '$SCREEN_SESSION'..."

# The screen window always runs a plain, persistent `bash` — never `bash -c "... && npm start"`
# directly. If npm start were the window's own command, Ctrl-C-ing it to stop the bot would
# make that command (and so the shell, and so the single-window session) exit immediately,
# leaving nothing for the restart command below to `stuff` into.
if ! screen -list | grep -Eq "[0-9]+\.${SCREEN_SESSION}[[:space:]]"; then
    echo "==> Screen session '$SCREEN_SESSION' not found. Creating it..."
    screen -dmS "$SCREEN_SESSION" bash
fi

if pgrep -f "node dist/index.js" > /dev/null 2>&1; then
    screen -S "$SCREEN_SESSION" -X stuff $'\003'

    # Wait up to 15s for the node process to fully exit before restarting.
    for _ in {1..15}; do
        pgrep -f "node dist/index.js" > /dev/null 2>&1 || break
        sleep 1
    done

    if pgrep -f "node dist/index.js" > /dev/null 2>&1; then
        echo "WARNING: Node process did not stop within 15s. Attempting restart anyway..."
    fi
fi

screen -S "$SCREEN_SESSION" -X stuff "cd '${REPO_DIR}' && npm start\n"
echo "==> Bot restarted."

echo "==> Deploy complete."
