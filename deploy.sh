#!/usr/bin/env bash
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
# systemd unit the bot runs as (installed by scripts/install-systemd-service.sh).
SERVICE_NAME="bcuk-bot"
# How long to wait for the restarted bot to answer /healthz before calling the deploy failed.
# Startup pings the DB, loads the guild registry and logs in to Discord/Twitch before the panel
# starts listening, so allow for slow logins.
HEALTH_TIMEOUT_SECONDS=90
# Longest debug window `deploy.sh debug <hours>` accepts. Matches MAX_DEBUG_LOGGING_HOURS in
# src/shared/debugLogging.ts, which also refuses a longer saved window at startup.
MAX_DEBUG_HOURS=72
# ─────────────────────────────────────────────────────────────────────────────

# ── Arguments ────────────────────────────────────────────────────────────────
# `npm run deploy debug [hours]` (or `bash deploy.sh debug [hours]`) also turns on the bot's debug
# log file, logs/debug-YYYY-MM-DD.log, for that many hours (default 24) from the restart. It
# switches itself off when the time runs out. The owner Health page (/admin/health) can turn it on
# or off without a deploy.
DEBUG_HOURS=""
if [ "${1:-}" = "debug" ]; then
    if [ "$#" -gt 2 ]; then
        echo "Usage: npm run deploy [debug [hours]]"
        exit 1
    fi
    # Only a missing hours argument means 24: an empty one ("") fails the check below.
    DEBUG_HOURS="${2-24}"
    if ! [[ "$DEBUG_HOURS" =~ ^[0-9]+$ ]] || [ "$DEBUG_HOURS" -lt 1 ] || [ "$DEBUG_HOURS" -gt "$MAX_DEBUG_HOURS" ]; then
        echo "ERROR: Debug hours must be a whole number from 1 to $MAX_DEBUG_HOURS (got '$DEBUG_HOURS')."
        exit 1
    fi
elif [ "$#" -gt 0 ]; then
    echo "Usage: npm run deploy [debug [hours]]"
    exit 1
fi

cd "$(dirname "$0")"

[ -f package.json ] || { echo "ERROR: Run this script from the repo root."; exit 1; }

# Resolved the same way scripts/install-systemd-service.sh resolves it for the sudoers rule. sudo
# matches that rule against the absolute path, and a bare `sudo systemctl` would be looked up on
# sudo's own secure_path instead, which can land on a different path.
SYSTEMCTL_BIN="$(command -v systemctl || true)"
[ -n "$SYSTEMCTL_BIN" ] || { echo "ERROR: systemctl is required (the bot runs as a systemd service)."; exit 1; }

# Check the restart path works before changing anything, so a missing unit or sudo rule fails
# the deploy up front instead of after the new build is already in place.
if ! "$SYSTEMCTL_BIN" cat "$SERVICE_NAME" > /dev/null 2>&1; then
    echo "ERROR: systemd service '$SERVICE_NAME' isn't installed."
    echo "       Run once: bash scripts/install-systemd-service.sh (see README \"Running the bot\")."
    exit 1
fi
if ! sudo -n -l "$SYSTEMCTL_BIN" restart "$SERVICE_NAME" > /dev/null 2>&1; then
    echo "ERROR: $(id -un) can't run 'sudo systemctl restart $SERVICE_NAME' without a password."
    echo "       Re-run: bash scripts/install-systemd-service.sh"
    exit 1
fi
command -v curl > /dev/null || { echo "ERROR: curl is required for the post-restart health check."; exit 1; }
command -v ss > /dev/null || { echo "ERROR: ss (iproute2) is required for the post-restart health check."; exit 1; }

PREVIOUS_SHA=$(git rev-parse HEAD)

# The build compiles into this staging folder, which only replaces dist/ once the tests have
# passed (see "Swapping in the new build" below). Building straight into dist/ would leave a
# rollback with the new, untested code in dist/ for the next `npm start`, and tsc never deletes
# output for removed sources — a fresh folder per deploy drops those stale files too.
BUILD_DIR="dist.new"
# Set once this deploy has swapped its build into dist/, so rollback only undoes its own swap —
# never a dist.old left behind by an earlier, interrupted deploy.
SWAPPED=0

# On any error after git pull, roll back to the previous commit and the previous build: dist/ is
# untouched until the swap, and kept as dist.old from then until the deploy succeeds.
rollback() {
    echo "ERROR: Deployment failed. Rolling back to $PREVIOUS_SHA..."
    rm -rf "$BUILD_DIR"
    # Past the swap, dist/ holds this deploy's build and dist.old the previous one (if there was
    # one) until the deploy succeeds — put the previous build back.
    if [ "$SWAPPED" -eq 1 ]; then
        rm -rf dist
        if [ -d dist.old ]; then mv dist.old dist; fi
    fi
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

# Restores the dev dependencies pruned by the previous deploy without reinstalling the rest, then
# restores the tracked lockfile. Returns non-zero if the install fails, so the caller can fall
# back to a clean `npm ci`.
install_dependencies_incrementally() {
    npm install --include=dev --prefer-offline --no-audit --no-fund || return 1
    # npm may rewrite the lockfile's formatting even with no dependency change (see the prune
    # note below); restore the tracked copy so the tree still matches what `npm ci` would install.
    git checkout -- package-lock.json
}

# The unit runs the node binary it was installed with (ExecStart), not whichever one is on this
# shell's PATH, so `engine-strict` in .npmrc alone can't catch it: after upgrading Node (e.g. a new
# nvm version in a new folder) the service would keep restarting on the old binary. Check that
# binary against `engines` before installing anything.
SERVICE_NODE_BIN="$("$SYSTEMCTL_BIN" show -p ExecStart --value "$SERVICE_NAME" | sed -n 's/.*path=\([^ ;]*\).*/\1/p')"
NODE_MIN="$(sed -n 's/.*"node": ">=\([0-9.]*\)".*/\1/p' package.json)"
if [ -z "$SERVICE_NODE_BIN" ] || ! "$SERVICE_NODE_BIN" -e '
    const min = process.argv[1].split(".").map(Number);
    const cur = process.versions.node.split(".").map(Number);
    const i = min.findIndex((part, n) => cur[n] !== part);
    process.exit(i === -1 || cur[i] > min[i] ? 0 : 1);
' "$NODE_MIN"; then
    echo "ERROR: $SERVICE_NAME runs ${SERVICE_NODE_BIN:-an unknown node}, which isn't Node $NODE_MIN or later."
    echo "       Install a newer Node, then re-run: bash scripts/install-systemd-service.sh"
    rollback
fi

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

rm -rf "$BUILD_DIR"
npm run build -- --outDir "$BUILD_DIR" > "$BUILD_LOG" 2>&1 &
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

# Prune before the swap: a failure here rolls back with dist/ still untouched.
echo "==> Pruning dev dependencies..."
npm prune --omit=dev

# npm (as of npm 12) rewrites package-lock.json during `prune --omit=dev` to
# drop dev-only entries, even though nothing in package.json changed. Left
# alone, that leaves the working tree dirty and trips the next deploy's
# uncommitted-changes check above. The pruned node_modules is unaffected by
# discarding this rewrite — restore the tracked lockfile so it still reflects
# the full dev+prod graph `npm ci` needs next time.
git checkout -- package-lock.json

echo "==> Swapping in the new build..."
rm -rf dist.old  # Left over from an interrupted deploy.
if [ -d dist ]; then mv dist dist.old; fi
SWAPPED=1
mv "$BUILD_DIR" dist

trap - ERR  # Rollback no longer needed — code is good.
rm -rf dist.old

# Reads WEB_PORT from .env (the bot's own source of truth for it) the way dotenv does: last entry
# wins, an inline ` # comment` is dropped, surrounding quotes and spaces are stripped. No entry
# (grep finding nothing must not trip pipefail) or a blank one falls back to 3000, like config.ts.
WEB_PORT_SETTING="$( { grep -E '^[[:space:]]*WEB_PORT=' .env 2>/dev/null || true; } \
    | tail -n 1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//' | tr -d "[:space:]\"'")"
WEB_PORT="${WEB_PORT_SETTING:-3000}"
HEALTH_URL="http://127.0.0.1:${WEB_PORT}/healthz"

# Prints the PIDs listening on WEB_PORT, one per line (nothing if none, or if ss can't see them).
# deploy.sh runs as the service's own user, so ss can see the bot's PID.
port_listener_pids() {
    { ss -Hltnp "sport = :${WEB_PORT}" 2>/dev/null || true; } | { grep -o 'pid=[0-9]*' || true; } | cut -d= -f2 | sort -u
}

# The bot reads this at startup (restoreDebugLogging), so the new process starts with debug logging
# on. logs/ is gitignored, so it never dirties the next deploy's working-tree check.
if [ -n "$DEBUG_HOURS" ]; then
    mkdir -p logs
    # Written to a temporary file and renamed into place, so an interrupted write never leaves a
    # half-written state file for the bot to discard.
    "$SERVICE_NODE_BIN" -e '
        const fs = require("fs");
        const until = new Date(Date.now() + Number(process.argv[1]) * 3600000).toISOString();
        fs.writeFileSync("logs/debug-logging.json.tmp", JSON.stringify({ until }));
        fs.renameSync("logs/debug-logging.json.tmp", "logs/debug-logging.json");
    ' "$DEBUG_HOURS"
    echo "==> Debug logging will be on for ${DEBUG_HOURS}h from the restart (logs/debug-YYYY-MM-DD.log)."
fi

echo "==> Restarting $SERVICE_NAME..."
# SIGTERM runs the bot's graceful shutdown; systemd waits for it (TimeoutStopSec) before starting
# the new build.
sudo -n "$SYSTEMCTL_BIN" restart "$SERVICE_NAME"

echo "==> Waiting up to ${HEALTH_TIMEOUT_SECONDS}s for $HEALTH_URL..."
HEALTHY=0
# A deadline on elapsed time (bash's SECONDS), not a count of attempts: each curl can take up
# to its own 2s timeout on top of the 1s sleep.
HEALTH_DEADLINE=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
while [ "$SECONDS" -lt "$HEALTH_DEADLINE" ]; do
    if curl -fsS --max-time 2 "$HEALTH_URL" > /dev/null 2>&1; then
        # A 200 only counts if it came from the unit's own process. Something else on the port, such
        # as the old screen-session bot left running, would answer while the new one crash-loops on
        # EADDRINUSE. `restart` waits for the old process to exit, so a different listener is never
        # the previous build.
        MAIN_PID="$("$SYSTEMCTL_BIN" show -p MainPID --value "$SERVICE_NAME")"
        LISTENER_PIDS="$(port_listener_pids)"
        if [ "${MAIN_PID:-0}" != "0" ] && printf '%s\n' "$LISTENER_PIDS" | grep -qx "$MAIN_PID"; then
            HEALTHY=1
            break
        fi
        if [ -n "$LISTENER_PIDS" ]; then
            FOREIGN_PIDS="$(printf '%s' "$LISTENER_PIDS" | tr '\n' ' ')"
            echo "ERROR: Port $WEB_PORT is held by PID ${FOREIGN_PIDS% }, not $SERVICE_NAME (MainPID $MAIN_PID). Is an old instance (e.g. in screen) still running?"
            break
        fi
    fi
    # The unit never gives up on its own (see StartLimitIntervalSec in the unit), so "failed" here
    # means something stopped it for good, e.g. a bad ExecStart; stop waiting and show why. A
    # start that keeps crashing and retrying runs out the deadline instead.
    if "$SYSTEMCTL_BIN" is-failed --quiet "$SERVICE_NAME"; then
        break
    fi
    sleep 1
done

if [ "$HEALTHY" -ne 1 ]; then
    echo "ERROR: $SERVICE_NAME didn't come up healthy on $HEALTH_URL after the restart. The new build is in place; the bot may be crash-looping or stopped."
    echo "--- systemctl status $SERVICE_NAME ---"
    "$SYSTEMCTL_BIN" status "$SERVICE_NAME" --no-pager --lines=0 || true
    echo "--- last 50 log lines (journalctl -u $SERVICE_NAME) ---"
    journalctl -u "$SERVICE_NAME" -n 50 --no-pager || echo "(couldn't read the journal; add this user to the systemd-journal group to see it here)"
    exit 1
fi

echo "==> $SERVICE_NAME is up."
echo "==> Deploy complete."
