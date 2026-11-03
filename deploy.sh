#!/usr/bin/env bash
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
# systemd unit the bot runs as (installed by scripts/install-systemd-service.sh).
SERVICE_NAME="bcuk-bot"
# How long to wait for the restarted bot to answer /healthz before calling the deploy failed.
# Startup pings the DB, loads the guild registry and logs in to Discord/Twitch before the panel
# starts listening, so allow for slow logins.
HEALTH_TIMEOUT_SECONDS="${DEPLOY_HEALTH_TIMEOUT_SECONDS:-90}"
# Once /healthz first answers, how long the bot must then stay up (same process, no restarts, still
# answering) before the deploy counts as good. Catches a build that comes up and then crashes, e.g.
# when a Discord/Twitch login fails a few seconds after the panel starts listening.
STABILITY_SECONDS="${DEPLOY_STABILITY_SECONDS:-30}"
# Where a failed deploy's report is saved (logs/ is gitignored).
FAILURE_LOG="logs/last-deploy-failure.log"
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
    # Only a missing hours argument means 24: an empty one ("") fails the check below. At most two
    # digits before comparing, so an oversized number can't overflow the shell's integer test
    # (which errors, and so would let it through).
    DEBUG_HOURS="${2-24}"
    if ! [[ "$DEBUG_HOURS" =~ ^[0-9]{1,2}$ ]] || [ "$DEBUG_HOURS" -lt 1 ] || [ "$DEBUG_HOURS" -gt "$MAX_DEBUG_HOURS" ]; then
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
PREVIOUS_SHORT=$(git rev-parse --short HEAD)
NEW_SHORT=""

# The build compiles into this staging folder, which only replaces dist/ once the tests have
# passed (see "Swapping in the new build" below). Building straight into dist/ would leave a
# rollback with the new, untested code in dist/ for the next `npm start`, and tsc never deletes
# output for removed sources — a fresh folder per deploy drops those stale files too.
BUILD_DIR="dist.new"
# Set once this deploy has swapped its build into dist/, so rollback only undoes its own swap —
# never a dist.old left behind by an earlier, interrupted deploy.
SWAPPED=0
# Set once this deploy has moved the previous node_modules aside (to node_modules.old) for a clean
# install, so rollback can put it back instead of reinstalling the old dependencies.
MOVED_NODE_MODULES=0
# Set once the service has been restarted onto the new build. From then on, rolling back also means
# restarting onto the previous build and checking that it comes up.
RESTARTED=0
# Local time of the last restart (journalctl --since, and the bot's own log lines, use local time).
RESTART_TIME=""
# What went wrong, for the failure report. The ERR trap fills FAILED_COMMAND in.
FAILURE_REASON=""
FAILED_COMMAND=""
# The pre-restart database dump, if one was taken.
BACKUP_FILE=""
# Migration files this deploy adds (set after the pull).
NEW_MIGRATIONS=""

# Prints a line and appends it to the failure report.
report() {
    printf '%s\n' "$*" | tee -a "$FAILURE_LOG"
}

# Prints the service's status and its log since the last restart, and appends them to the failure
# report. Falls back to the bot's own log file when the journal can't be read (this user isn't in
# the systemd-journal group).
report_service_details() {
    report ""
    report "--- systemctl status $SERVICE_NAME ---"
    "$SYSTEMCTL_BIN" status "$SERVICE_NAME" --no-pager --lines=0 2>&1 | tee -a "$FAILURE_LOG" || true
    report "--- $SERVICE_NAME log since the restart at $RESTART_TIME (last 80 lines) ---"
    service_log_since_restart | tail -n 80 | tee -a "$FAILURE_LOG"
    report "---"
}

# Prints what the bot logged since RESTART_TIME: the journal if this user can read it, otherwise
# the newest lines of the bot's own combined log whose timestamp is at or after the restart.
service_log_since_restart() {
    local journal latest
    journal="$(journalctl -u "$SERVICE_NAME" --since "$RESTART_TIME" -o cat --no-pager 2>/dev/null || true)"
    if [ -n "$journal" ] && ! printf '%s' "$journal" | grep -q '^-- No entries --$'; then
        printf '%s\n' "$journal"
        return
    fi
    latest="$(ls -t logs/combined-*.log 2>/dev/null | head -n 1 || true)"
    if [ -n "$latest" ]; then
        awk -v since="$RESTART_TIME" 'substr($0, 1, 19) >= since' "$latest"
    else
        echo "(no log available: the journal isn't readable by $(id -un) and logs/ has no combined log)"
    fi
}

# True if the new build applied any of this deploy's new migrations since the restart. The runner
# logs "Applying migration <version>..." before running each one. When neither the journal nor the
# bot's log can be read, it can't tell, so it assumes they were (the safe answer).
new_migrations_were_applied() {
    local log version
    [ -n "$NEW_MIGRATIONS" ] || return 1
    log="$(service_log_since_restart)"
    if printf '%s' "$log" | grep -q '^(no log available'; then return 0; fi
    for version in $NEW_MIGRATIONS; do
        if printf '%s' "$log" | grep -qF "Applying migration $version"; then return 0; fi
    done
    return 1
}

# Leaves the new build in place and explains how to go back by hand. Used when the failed build
# already changed the schema: the previous build refuses to start against a database recording a
# migration it has no file for, so restoring its code alone would leave the bot down.
stop_without_rollback() {
    report ""
    report "NOT rolling back automatically: the new build already applied database migration(s):"
    for version in $NEW_MIGRATIONS; do report "    $version"; done
    report "The previous build ($PREVIOUS_SHORT) refuses to start on a database that records migrations it"
    report "doesn't have, so putting its code back alone would leave the bot down. The new build"
    report "($NEW_SHORT) is still in place."
    report ""
    report "Either fix forward (push a fix, then deploy again), or go back by hand:"
    report "  sudo systemctl stop $SERVICE_NAME"
    if [ -n "$BACKUP_FILE" ]; then
        report "  bash scripts/restore-db.sh \"$BACKUP_FILE\"    # the backup taken just before the restart"
    else
        report "  # restore the newest backup from before this deploy (see README \"Backups\")"
    fi
    report "  git reset --hard $PREVIOUS_SHA"
    if [ "$SWAPPED" -eq 1 ] && [ -d dist.old ]; then report "  rm -rf dist && mv dist.old dist"; fi
    if [ "$MOVED_NODE_MODULES" -eq 1 ] && [ -d node_modules.old ]; then
        report "  rm -rf node_modules && mv node_modules.old node_modules"
    fi
    report "  sudo systemctl start $SERVICE_NAME"
}

# Puts the previous code, build and dependencies back. If the service was already restarted onto the
# new build, restarts it onto the previous one and checks that it comes up. Always writes a failure
# report (printed and saved to FAILURE_LOG) and exits 1.
rollback() {
    trap - ERR
    set +e
    mkdir -p logs
    : > "$FAILURE_LOG"
    report ""
    report "=================================================================="
    report "ERROR: Deploy failed: ${FAILURE_REASON:-a deploy step failed}"
    if [ -n "$FAILED_COMMAND" ]; then report "       Failed command: $FAILED_COMMAND"; fi
    report "       New commit:      ${NEW_SHORT:-not pulled}"
    report "       Previous commit: $PREVIOUS_SHORT"
    report "=================================================================="
    if [ "$RESTARTED" -eq 1 ]; then
        report_service_details
        if new_migrations_were_applied; then
            stop_without_rollback
            report ""
            report "Report saved to $FAILURE_LOG"
            exit 1
        fi
    fi

    report ""
    report "==> Rolling back to $PREVIOUS_SHORT..."
    rm -rf "$BUILD_DIR"
    # Past the swap, dist/ holds this deploy's build and dist.old the previous one (if there was
    # one) until the deploy succeeds — put the previous build back.
    if [ "$SWAPPED" -eq 1 ]; then
        rm -rf dist
        if [ -d dist.old ]; then mv dist.old dist; fi
    fi
    if [ "$MOVED_NODE_MODULES" -eq 1 ]; then
        rm -rf node_modules
        if [ -d node_modules.old ]; then mv node_modules.old node_modules; fi
    fi
    git reset -q --hard "$PREVIOUS_SHA"

    local outcome="The service wasn't restarted, so the bot is still running the previous build ($PREVIOUS_SHORT)."
    if [ "$RESTARTED" -eq 1 ]; then
        report "==> Restarting $SERVICE_NAME on the previous build..."
        RESTART_TIME="$(date '+%Y-%m-%d %H:%M:%S')"
        if sudo -n "$SYSTEMCTL_BIN" restart "$SERVICE_NAME" && wait_for_health && wait_for_stability; then
            outcome="Rolled back: $SERVICE_NAME is running the previous build ($PREVIOUS_SHORT) and answering health checks."
        else
            outcome="ROLLBACK FAILED: the previous build didn't come up healthy either (${HEALTH_PROBLEM:-restart failed}). The bot is DOWN."
            report_service_details
        fi
    fi
    report ""
    report "$outcome"
    report "Report saved to $FAILURE_LOG"
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
NEW_SHORT=$(git rev-parse --short HEAD)
# Migration versions (file names without .sql) this deploy adds, if any. Decides whether the database
# backup before the restart is required, and whether a failed restart can still be rolled back.
NEW_MIGRATIONS="$(git diff --name-only --diff-filter=A "$PREVIOUS_SHA" HEAD -- 'migrations/*.sql' \
    | sed -e 's|^migrations/||' -e 's|\.sql$||' | tr '\n' ' ')"
NEW_MIGRATIONS="${NEW_MIGRATIONS% }"

# Any failing command from here on rolls the deploy back (see rollback), recording which one failed.
trap 'FAILED_COMMAND=$BASH_COMMAND; rollback' ERR

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
    FAILURE_REASON="the service's node is older than package.json's engines requirement"
    rollback
fi

echo "==> Installing dependencies..."
if [ "$DEPS_CHANGED" -eq 0 ] && [ -d node_modules ] && install_dependencies_incrementally; then
    echo "==> Dependencies unchanged — restored dev dependencies in place."
else
    # `npm ci` deletes node_modules before installing. Move it aside instead, so a failed deploy can
    # put the previous dependencies straight back rather than reinstalling them (no network needed).
    rm -rf node_modules.old  # Left over from an interrupted deploy.
    if [ -d node_modules ]; then
        mv node_modules node_modules.old
        MOVED_NODE_MODULES=1
    fi
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
    FAILURE_REASON="the build or the tests failed (see their output above)"
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
# dist.old (and node_modules.old, if the dependencies changed) stay until the new build has proved
# healthy, so a failed restart can roll straight back to them.

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

# Waits up to HEALTH_TIMEOUT_SECONDS for /healthz to answer from the unit's own process. Returns 1
# with HEALTH_PROBLEM set to why when it doesn't.
wait_for_health() {
    local deadline main_pid listener_pids foreign_pids
    HEALTH_PROBLEM="it didn't answer $HEALTH_URL within ${HEALTH_TIMEOUT_SECONDS}s (crash-looping or stuck starting?)"
    # A deadline on elapsed time (bash's SECONDS), not a count of attempts: each curl can take up
    # to its own 2s timeout on top of the 1s sleep.
    deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if curl -fsS --max-time 2 "$HEALTH_URL" > /dev/null 2>&1; then
            # A 200 only counts if it came from the unit's own process. Something else on the port,
            # such as the old screen-session bot left running, would answer while the new one
            # crash-loops on EADDRINUSE. `restart` waits for the old process to exit, so a different
            # listener is never the previous build.
            main_pid="$("$SYSTEMCTL_BIN" show -p MainPID --value "$SERVICE_NAME")"
            listener_pids="$(port_listener_pids)"
            if [ "${main_pid:-0}" != "0" ] && printf '%s\n' "$listener_pids" | grep -qx "$main_pid"; then
                return 0
            fi
            if [ -n "$listener_pids" ]; then
                foreign_pids="$(printf '%s' "$listener_pids" | tr '\n' ' ')"
                HEALTH_PROBLEM="port $WEB_PORT is held by PID ${foreign_pids% }, not $SERVICE_NAME (MainPID $main_pid). Is an old instance (e.g. in screen) still running?"
                return 1
            fi
        fi
        # The unit never gives up on its own (see StartLimitIntervalSec in the unit), so "failed" here
        # means something stopped it for good, e.g. a bad ExecStart; stop waiting and show why. A
        # start that keeps crashing and retrying runs out the deadline instead.
        if "$SYSTEMCTL_BIN" is-failed --quiet "$SERVICE_NAME"; then
            HEALTH_PROBLEM="systemd reports $SERVICE_NAME as failed"
            return 1
        fi
        sleep 1
    done
    return 1
}

# After the first healthy answer, checks the bot stays up for STABILITY_SECONDS: the same process,
# no restarts, still answering. Returns 1 with HEALTH_PROBLEM set when it doesn't.
wait_for_stability() {
    local main_pid restarts
    main_pid="$("$SYSTEMCTL_BIN" show -p MainPID --value "$SERVICE_NAME")"
    restarts="$("$SYSTEMCTL_BIN" show -p NRestarts --value "$SERVICE_NAME")"
    sleep "$STABILITY_SECONDS"
    if [ "$("$SYSTEMCTL_BIN" show -p MainPID --value "$SERVICE_NAME")" != "$main_pid" ] \
        || [ "$("$SYSTEMCTL_BIN" show -p NRestarts --value "$SERVICE_NAME")" != "$restarts" ] \
        || ! curl -fsS --max-time 2 "$HEALTH_URL" > /dev/null 2>&1; then
        HEALTH_PROBLEM="it came up but crashed, restarted or stopped answering within ${STABILITY_SECONDS}s"
        return 1
    fi
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

# A dump from just before the restart is the way back if the new build's migrations go wrong, so it
# is required when this deploy adds migrations. Otherwise a failed backup only warns.
echo "==> Backing up the database..."
if BACKUP_OUTPUT="$(bash scripts/backup-db.sh pre-deploy)"; then
    BACKUP_FILE="$(printf '%s\n' "$BACKUP_OUTPUT" | tail -n 1)"
    echo "    Saved $BACKUP_FILE"
elif [ -n "$NEW_MIGRATIONS" ]; then
    FAILURE_REASON="couldn't back up the database, and this deploy adds migrations ($NEW_MIGRATIONS); not restarting without a backup"
    rollback
else
    echo "WARNING: Couldn't back up the database (see above). Continuing, since this deploy adds no migrations."
fi

echo "==> Restarting $SERVICE_NAME..."
# SIGTERM runs the bot's graceful shutdown; systemd waits for it (TimeoutStopSec) before starting
# the new build. Marked restarted first, so even a failed restart command rolls back by restarting.
RESTARTED=1
RESTART_TIME="$(date '+%Y-%m-%d %H:%M:%S')"
sudo -n "$SYSTEMCTL_BIN" restart "$SERVICE_NAME"

echo "==> Waiting up to ${HEALTH_TIMEOUT_SECONDS}s for $HEALTH_URL, then ${STABILITY_SECONDS}s to check it stays up..."
if ! wait_for_health || ! wait_for_stability; then
    FAILURE_REASON="$SERVICE_NAME didn't come up healthy after the restart: $HEALTH_PROBLEM"
    rollback
fi

trap - ERR  # The new build is up and stayed up: nothing left to roll back.
rm -rf dist.old node_modules.old
echo "==> $SERVICE_NAME is up."
echo "==> Deploy complete."
