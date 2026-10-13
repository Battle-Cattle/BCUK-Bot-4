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

# The previous deploy left node_modules holding exactly the lockfile's production dependencies
# (`npm prune --omit=dev` below). When neither package.json nor the lockfile changed since then,
# `npm install --include=dev` only has to add the dev dependencies back — same resulting tree as a
# clean `npm ci`, without deleting and re-extracting every package (or re-running postinstall
# downloads such as ffmpeg-static's). Anything else (dependency change, missing node_modules, or
# the incremental install failing) falls back to a clean `npm ci`.
DEPS_CHANGED=0
if ! git diff --quiet "$PREVIOUS_SHA" HEAD -- package.json package-lock.json; then
    DEPS_CHANGED=1
fi

install_dependencies_incrementally() {
    npm install --include=dev --prefer-offline --no-audit --no-fund || return 1
    # npm may rewrite the lockfile's formatting even with no dependency change (see the prune
    # note below); restore the tracked copy so the tree still matches what `npm ci` would install.
    git checkout -- package-lock.json
}

echo "==> Installing dependencies..."
if [ "$DEPS_CHANGED" -eq 0 ] && [ -d node_modules ] && install_dependencies_incrementally; then
    echo "==> Dependencies unchanged — restored dev dependencies in place."
else
    retry npm ci
fi

# Vitest's on-disk transform cache (.vitest-cache, see vitest.config.mts) lives outside
# node_modules so it survives `npm ci` and keeps test runs warm across deploys. Drop it whenever
# the dependencies changed, so a dependency/Vitest upgrade always starts cold.
if [ "$DEPS_CHANGED" -eq 1 ]; then
    echo "==> package.json/package-lock.json changed — clearing the Vitest transform cache..."
    rm -rf .vitest-cache
fi

echo "==> Checking for vulnerabilities..."
npm audit --audit-level=high

echo "==> Building and running tests in parallel..."
# Tests import directly from src/*.ts (vitest transforms on the fly), not from
# dist/, so the build and test suite have no dependency on each other.
# Tests take longer, so their output streams live; the build's output is
# captured and dumped only after both finish, so it can't interleave with
# (and garble) vitest's live ANSI progress output.
BUILD_LOG=$(mktemp)
trap 'rm -f "$BUILD_LOG"' EXIT

npm run build > "$BUILD_LOG" 2>&1 &
BUILD_PID=$!
npm test &
TEST_PID=$!

BUILD_STATUS=0
TEST_STATUS=0
wait "$BUILD_PID" || BUILD_STATUS=$?
wait "$TEST_PID" || TEST_STATUS=$?

echo "--- Build output ---"
cat "$BUILD_LOG"

if [ "$BUILD_STATUS" -ne 0 ] || [ "$TEST_STATUS" -ne 0 ]; then
    rollback
fi

echo "==> Pruning dev dependencies..."
npm prune --omit=dev

# npm (as of npm 12) rewrites package-lock.json during `prune --omit=dev` to
# drop dev-only entries, even though nothing in package.json changed. Left
# alone, that leaves the working tree dirty and trips the next deploy's
# uncommitted-changes check above. The pruned node_modules is unaffected by
# discarding this rewrite — restore the tracked lockfile so it still reflects
# the full dev+prod graph `npm ci` needs next time.
git checkout -- package-lock.json

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
