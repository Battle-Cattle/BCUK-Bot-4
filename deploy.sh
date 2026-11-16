#!/usr/bin/env bash
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
# systemd unit the bot runs as (installed by scripts/install-systemd-service.sh).
SERVICE_NAME="bcuk-bot"
# How long to wait for the restarted bot to answer /healthz before calling the deploy failed.
# Startup pings the DB, loads the guild registry and logs in to Discord/Twitch before the panel
# starts listening, so allow for slow logins.
HEALTH_TIMEOUT_SECONDS="${DEPLOY_HEALTH_TIMEOUT_SECONDS:-90}"
# How long a rollback waits for an interrupted deploy's build and tests to exit after asking them to
# stop, before killing whatever is left.
JOB_STOP_TIMEOUT_SECONDS="${DEPLOY_JOB_STOP_TIMEOUT_SECONDS:-10}"
# Once /healthz first answers, how long the bot must then stay up (same process, no restarts, still
# answering) before the deploy counts as good. Catches a build that comes up and then crashes, e.g.
# when a Discord/Twitch login fails a few seconds after the panel starts listening.
STABILITY_SECONDS="${DEPLOY_STABILITY_SECONDS:-30}"
# Pause between health probes and between stability checks. Whole or fractional seconds; the tests
# shorten it so a deploy that has to wait finishes quickly. The timeouts above take fractions too.
POLL_INTERVAL_SECONDS="${DEPLOY_POLL_INTERVAL_SECONDS:-1}"
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
[ -n "${EPOCHREALTIME:-}" ] || { echo "ERROR: bash 5 or later is required (the health check times itself with EPOCHREALTIME)."; exit 1; }

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
# Set just before each of those moves starts, so an interrupt that lands mid-move (after the mv, but
# before the flag after it) is still undone when the folder it moved is the only copy left.
MOVING_NODE_MODULES=0
MOVING_DIST=0
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

# Converts a number of seconds, whole or with a decimal part ("90", "0.3"), to whole microseconds in
# MICROS (a variable, not output, so callers need no subshell). Anything else is an error, since a
# timeout that silently became 0 would fail a healthy deploy.
MICROS=0
seconds_to_micros() {
    local whole fraction
    if ! [[ "$1" =~ ^([0-9]+)(\.([0-9]{1,6})[0-9]*)?$ ]]; then
        echo "ERROR: '$1' isn't a number of seconds (like 90 or 0.3)."
        return 1
    fi
    whole="${BASH_REMATCH[1]}"
    fraction="${BASH_REMATCH[3]:-}000000"
    MICROS=$((10#$whole * 1000000 + 10#${fraction:0:6}))
}

# Sets NOW_MICROS to the current time in whole microseconds. EPOCHREALTIME (bash 5+) uses the
# locale's decimal separator, hence the pattern accepting a comma too.
NOW_MICROS=0
now_micros() {
    NOW_MICROS=$((10#${EPOCHREALTIME/[.,]/}))
}

# Sets DEADLINE_MICROS to $1 seconds (whole or fractional) from now.
DEADLINE_MICROS=0
set_deadline() {
    seconds_to_micros "$1" || return 1
    now_micros
    DEADLINE_MICROS=$((NOW_MICROS + MICROS))
}

# Fail now on a bad timeout or interval rather than after the new build is in place.
for setting in "$HEALTH_TIMEOUT_SECONDS" "$STABILITY_SECONDS" "$JOB_STOP_TIMEOUT_SECONDS" "$POLL_INTERVAL_SECONDS"; do
    seconds_to_micros "$setting" || exit 1
done
# A zero (or tiny) interval would run curl and systemctl back to back for the whole window.
seconds_to_micros "$POLL_INTERVAL_SECONDS"
if [ "$MICROS" -lt 10000 ]; then
    echo "ERROR: DEPLOY_POLL_INTERVAL_SECONDS must be at least 0.01 (got '$POLL_INTERVAL_SECONDS')."
    exit 1
fi

# Sleeps one POLL_INTERVAL_SECONDS, but never past DEADLINE_MICROS, so a long interval can't stretch
# a health or stability window. Returns at once when the deadline has passed.
poll_sleep() {
    local remaining
    seconds_to_micros "$POLL_INTERVAL_SECONDS"
    now_micros
    remaining=$((DEADLINE_MICROS - NOW_MICROS))
    [ "$remaining" -gt 0 ] || return 0
    [ "$MICROS" -le "$remaining" ] || MICROS=$remaining
    sleep "$((MICROS / 1000000)).$(printf '%06d' $((MICROS % 1000000)))"
}

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

# The named lock the migration runner (src/db/migrations.ts) holds for as long as it migrates, and
# the marker line applied_migration_versions prints while someone holds it.
MIGRATION_LOCK_NAME="bcuk_bot_migrations"
MIGRATION_LOCK_MARKER="__migration_lock_held__"

# Prints the migration versions the database records as applied (schema_migrations), one per line,
# then MIGRATION_LOCK_MARKER if a migration is still in progress. A version is only recorded once its
# SQL finishes, so the lock is what shows a long migration that is still running.
# Runs in a subshell, so a missing setting can't exit deploy.sh itself. Fails if the query does.
applied_migration_versions() {
    (
        set -euo pipefail
        ENV_FILE=.env
        # shellcheck source=scripts/lib/dotenv.sh
        source scripts/lib/dotenv.sh
        load_db_settings
        credentials="$(write_mysql_credentials)"
        trap 'rm -f "$credentials"' EXIT
        mysql --defaults-extra-file="$credentials" -N -B "$DB_NAME" -e "SELECT version FROM schema_migrations;
            SELECT '$MIGRATION_LOCK_MARKER' FROM DUAL WHERE IS_USED_LOCK('$MIGRATION_LOCK_NAME') IS NOT NULL;"
    )
}

# Decides whether a failed restart can be rolled back. True (stop instead) whenever this deploy brings
# new migrations, or which ones it brings can't be told. Once the failed build has started, its
# migrations may have run: a recorded one makes the previous build refuse to start, and one that
# failed part way leaves the statements before the failure applied but unrecorded (MySQL commits
# each schema change at once), which nothing in the database reliably shows. A failed start almost
# always got past the migrations anyway (they run right after the database check), so stopping
# costs little. Sets MIGRATION_CHECK_NOTE to what the database says, for the report; it asks the
# database itself, not the bot's log (LOG_LEVEL can hide the runner's lines).
MIGRATION_CHECK_NOTE=""
new_migrations_block_rollback() {
    local applied version recorded=""
    if [ "$MIGRATION_STATE_UNKNOWN" -eq 1 ]; then
        MIGRATION_CHECK_NOTE="Couldn't read schema_migrations before the restart, so it's unknown which migrations this build applies; assuming it applied some."
        return 0
    fi
    [ -n "$NEW_MIGRATIONS" ] || return 1
    if ! applied="$(applied_migration_versions 2>&1)"; then
        MIGRATION_CHECK_NOTE="Couldn't read schema_migrations to check how far they got (${applied:-no output})."
        return 0
    fi
    if printf '%s\n' "$applied" | grep -qxF "$MIGRATION_LOCK_MARKER"; then
        MIGRATION_CHECK_NOTE="A migration is still running (the $MIGRATION_LOCK_NAME lock is held). Let it finish, or check the bot's log for it, before doing anything below; stopping the service now would cut it off part way."
        return 0
    fi
    for version in $NEW_MIGRATIONS; do
        if printf '%s\n' "$applied" | grep -qxF "$version"; then recorded="${recorded:+$recorded }$version"; fi
    done
    if [ -n "$recorded" ]; then
        MIGRATION_CHECK_NOTE="The database records these as applied: $recorded."
    else
        MIGRATION_CHECK_NOTE="None is recorded as applied, but one that failed part way leaves its earlier statements applied without being recorded. Check the bot's log for \"Migration ... failed\": if one failed, undo its changes by hand or restore the backup; if none started, the schema is unchanged."
    fi
    return 0
}

# Leaves the new build in place and explains how to go back by hand. Used when the failed build
# already changed the schema: the previous build refuses to start against a database recording a
# migration it has no file for, so restoring its code alone would leave the bot down.
stop_without_rollback() {
    report ""
    report "NOT rolling back automatically: this deploy brings new database migration(s), which the new build"
    report "may have applied, fully or part way:"
    for version in $NEW_MIGRATIONS; do report "    $version"; done
    if [ -n "$MIGRATION_CHECK_NOTE" ]; then report "($MIGRATION_CHECK_NOTE)"; fi
    report "The previous build ($PREVIOUS_SHORT) refuses to start on a database that records migrations it"
    report "doesn't have, and a migration that failed part way leaves the schema neither old nor new, so"
    report "putting its code back alone could leave the bot down or broken. The new build ($NEW_SHORT) is"
    report "still in place."
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

# Runs one rollback restore step, recording it in RESTORE_FAILURES if it fails (rollback runs with
# errexit off, so a failed step must not pass silently).
RESTORE_FAILURES=""
restore_step() {
    if ! "$@"; then
        RESTORE_FAILURES="${RESTORE_FAILURES:+$RESTORE_FAILURES; }$*"
    fi
}

# Background build and test jobs (set while they run). An interrupted deploy rolls back while they
# may still be going: background jobs in a script ignore Ctrl-C, and a TERM reaches only deploy.sh.
BUILD_PID=""
TEST_PID=""

# Sends signal $1 to process $2 and everything it started, deepest first (npm runs tsc and vitest
# as grandchildren, so signalling npm alone would leave them running), printing each PID signalled.
signal_tree() {
    local child
    for child in $(pgrep -P "$2" 2>/dev/null); do signal_tree "$1" "$child"; done
    kill "-$1" "$2" 2>/dev/null && echo "$2"
}

# True while a process is still running: it exists and isn't a zombie (one that has exited but not
# yet been reaped).
process_alive() {
    local state
    state="$(ps -o stat= -p "$1" 2>/dev/null)"
    [ -n "$state" ] && [ "${state#Z}" = "$state" ]
}

# True while any of the given processes is still running.
any_alive() {
    local pid
    for pid in "$@"; do process_alive "$pid" && return 0; done
    return 1
}

# Stops the background build and tests, if any are still running, so nothing writes into the
# checkout while the rollback restores it. Each job's whole process tree gets a TERM; anything still
# running JOB_STOP_TIMEOUT_SECONDS later (a process ignoring TERM) is killed, so the rollback can't
# hang on it. Then the jobs are reaped.
stop_background_jobs() {
    local pid signalled=""
    for pid in $BUILD_PID $TEST_PID; do signalled="$signalled $(signal_tree TERM "$pid" | tr '\n' ' ')"; done
    set_deadline "$JOB_STOP_TIMEOUT_SECONDS" || DEADLINE_MICROS=0
    now_micros
    # shellcheck disable=SC2086 # word-splitting the PID list is intended
    while [ "$NOW_MICROS" -lt "$DEADLINE_MICROS" ] && any_alive $signalled; do sleep 0.2; now_micros; done
    for pid in $signalled; do process_alive "$pid" && kill -KILL "$pid" 2>/dev/null; done
    for pid in $BUILD_PID $TEST_PID; do wait "$pid" 2>/dev/null; done
    BUILD_PID=""
    TEST_PID=""
}

# Puts the previous code, build and dependencies back. If the service was already restarted onto the
# new build, restarts it onto the previous one and checks that it comes up. Always writes a failure
# report (printed and saved to FAILURE_LOG) and exits 1.
rollback() {
    trap - ERR INT TERM
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
        if new_migrations_block_rollback; then
            stop_without_rollback
            report ""
            report "Report saved to $FAILURE_LOG"
            exit 1
        fi
    fi

    report ""
    report "==> Rolling back to $PREVIOUS_SHORT..."
    stop_background_jobs
    restore_step rm -rf "$BUILD_DIR"
    # Past the swap, dist/ holds this deploy's build and dist.old the previous one (if there was
    # one) until the deploy succeeds — put the previous build back.
    if [ "$SWAPPED" -eq 1 ]; then
        restore_step rm -rf dist
        if [ -d dist.old ]; then restore_step mv dist.old dist; fi
    elif [ "$MOVING_DIST" -eq 1 ] && [ ! -e dist ] && [ -d dist.old ]; then
        # Interrupted right after moving the previous build aside: put it back.
        restore_step mv dist.old dist
    fi
    if [ "$MOVED_NODE_MODULES" -eq 1 ]; then
        restore_step rm -rf node_modules
        if [ -d node_modules.old ]; then restore_step mv node_modules.old node_modules; fi
    elif [ "$MOVING_NODE_MODULES" -eq 1 ] && [ ! -e node_modules ] && [ -d node_modules.old ]; then
        # Interrupted right after moving the previous dependencies aside: put them back.
        restore_step mv node_modules.old node_modules
    fi
    restore_step git reset -q --hard "$PREVIOUS_SHA"

    local outcome="The service wasn't restarted, so the bot is still running the previous build ($PREVIOUS_SHORT)."
    if [ -n "$RESTORE_FAILURES" ]; then
        # Restarting onto a half-restored checkout would only make things worse; leave it for a person.
        report ""
        report "ROLLBACK INCOMPLETE: these restore steps failed: $RESTORE_FAILURES"
        report "dist/, node_modules/ or the checkout may not match $PREVIOUS_SHORT. Fix them by hand before the"
        report "next restart; the service was not restarted by the rollback."
        report "Report saved to $FAILURE_LOG"
        exit 1
    fi
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

# Puts back a folder an earlier deploy moved aside to <dir>.old, if that deploy was cut off (power loss,
# SIGKILL) before its rollback could run, so the .old copy may be the only good one. It moves back
# when <dir> is missing (cut off between the move aside and the new copy landing), or when <dir> is
# incomplete and the .old copy isn't: <marker> is a file that only a complete copy holds. Otherwise
# <dir> is complete and the .old copy is a stale leftover, which this deploy replaces when it moves
# <dir> aside itself.
recover_moved_aside() {
    local dir="$1" marker="$2" reason
    [ -d "$dir.old" ] || return 0
    if [ ! -e "$dir" ]; then
        reason="there is no $dir/"
    elif [ ! -e "$dir/$marker" ] && [ -e "$dir.old/$marker" ]; then
        reason="$dir/ is incomplete (no $marker)"
        rm -rf "$dir"
    else
        return 0
    fi
    echo "==> An earlier deploy was cut off before its rollback ran: $reason. Moving $dir.old/ back."
    mv "$dir.old" "$dir"
}

# Run before anything is deleted or moved. dist/ is the compiled entry point's folder; npm writes
# node_modules/.package-lock.json only once an install has finished.
recover_moved_aside dist index.js
recover_moved_aside node_modules .package-lock.json

echo "==> Pulling latest code..."
git update-index -q --refresh
if ! git diff-index --quiet HEAD --; then
    echo "ERROR: Working directory has uncommitted changes or untracked files."
    echo "       Commit or stash changes before deploying."
    exit 1
fi
git pull origin main
NEW_SHORT=$(git rev-parse --short HEAD)
# Migration versions (file names without .sql) this deploy adds (or renames), if any. Decides whether the database
# backup before the restart is required, and whether a failed restart can still be rolled back.
# record_unapplied_migrations adds any the database doesn't record yet just before the restart.
NEW_MIGRATIONS="$(git diff --name-only --diff-filter=AR "$PREVIOUS_SHA" HEAD -- 'migrations/*.sql' \
    | sed -e 's|^migrations/||' -e 's|\.sql$||' | tr '\n' ' ')"
NEW_MIGRATIONS="${NEW_MIGRATIONS% }"
# Set when the database's migration state couldn't be read before the restart: the backup is then
# required, and a failed restart is never rolled back automatically.
MIGRATION_STATE_UNKNOWN=0

# Adds to NEW_MIGRATIONS every migration file in the checkout that schema_migrations doesn't record
# yet. The diff above misses those when an earlier, interrupted deploy already pulled them (HEAD has
# moved on, so this deploy's diff is empty) but they were never applied. Sets MIGRATION_STATE_UNKNOWN
# when the database can't be read.
record_unapplied_migrations() {
    local recorded file version
    if ! recorded="$(applied_migration_versions 2>&1)"; then
        MIGRATION_STATE_UNKNOWN=1
        echo "WARNING: Couldn't read the database's migration state (${recorded:-no output}); treating this deploy as one that migrates."
        return
    fi
    for file in migrations/*.sql; do
        [ -e "$file" ] || continue
        version="$(basename "$file" .sql)"
        printf '%s\n' "$recorded" | grep -qxF "$version" && continue
        case " $NEW_MIGRATIONS " in *" $version "*) ;; *) NEW_MIGRATIONS="${NEW_MIGRATIONS:+$NEW_MIGRATIONS }$version" ;; esac
    done
}

# Any failing command from here on rolls the deploy back (see rollback), recording which one failed.
# So does Ctrl-C or a TERM: an interrupted deploy must not leave a half-swapped checkout behind
# (with, say, the only complete dependency tree sitting in node_modules.old).
trap 'FAILED_COMMAND=$BASH_COMMAND; rollback' ERR
trap 'FAILURE_REASON="the deploy was interrupted"; rollback' INT TERM

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
    rm -rf node_modules.old  # A stale leftover: recover_moved_aside put back any copy still needed.
    if [ -d node_modules ]; then
        MOVING_NODE_MODULES=1
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
BUILD_PID=""
TEST_PID=""

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
rm -rf dist.old  # A stale leftover: recover_moved_aside put back any copy still needed.
if [ -d dist ]; then
    MOVING_DIST=1
    mv dist dist.old
fi
SWAPPED=1
mv "$BUILD_DIR" dist
# dist.old (and node_modules.old, if the dependencies changed) stay until the new build has proved
# healthy, so a failed restart can roll straight back to them.

# Reads WEB_PORT and WEB_HOST from .env (the bot's own source of truth for them) the way dotenv
# does, with the same parser as the backup scripts (an `export ` prefix, spaces around `=` and
# quoting included): a setting read differently from the bot's would fail the health check and roll
# back a healthy build. Blank or missing values fall back to the same defaults as config.ts, which
# also trims both (spaces inside quotes survive env_setting, but not the bot's own reading of them).
ENV_FILE=.env
# shellcheck source=scripts/lib/dotenv.sh
source scripts/lib/dotenv.sh
# A restored backup or re-created .env can come back readable by every user on the host.
warn_if_env_readable_by_others
WEB_PORT_SETTING="$(trim "$(env_setting WEB_PORT)")"
WEB_PORT="${WEB_PORT_SETTING:-3000}"
WEB_HOST_SETTING="$(trim "$(env_setting WEB_HOST)")"
WEB_HOST="${WEB_HOST_SETTING:-127.0.0.1}"
# A wildcard bind is reachable on loopback; an IPv6 literal needs brackets in a URL.
case "$WEB_HOST" in
    0.0.0.0) HEALTH_HOST=127.0.0.1 ;;
    ::) HEALTH_HOST='[::1]' ;;
    *:*) HEALTH_HOST="[${WEB_HOST}]" ;;
    *) HEALTH_HOST="$WEB_HOST" ;;
esac
HEALTH_URL="http://${HEALTH_HOST}:${WEB_PORT}/healthz"

# Prints the PIDs listening on WEB_PORT, one per line (nothing if none, or if ss can't see them).
# deploy.sh runs as the service's own user, so ss can see the bot's PID.
port_listener_pids() {
    { ss -Hltnp "sport = :${WEB_PORT}" 2>/dev/null || true; } | { grep -o 'pid=[0-9]*' || true; } | cut -d= -f2 | sort -u
}

# Both health probes pass --noproxy '*': they go straight to the bot on this machine (or WEB_HOST's
# private address), never through a proxy the deploy shell may have set, which would fail them.
# Waits up to HEALTH_TIMEOUT_SECONDS for /healthz to answer from the unit's own process. Returns 1
# with HEALTH_PROBLEM set to why when it doesn't.
wait_for_health() {
    local main_pid listener_pids foreign_pids
    HEALTH_PROBLEM="it didn't answer $HEALTH_URL within ${HEALTH_TIMEOUT_SECONDS}s (crash-looping or stuck starting?)"
    # A deadline on elapsed time, not a count of attempts: each curl can take up to its own 2s
    # timeout on top of the sleep.
    set_deadline "$HEALTH_TIMEOUT_SECONDS"
    while [ "$NOW_MICROS" -lt "$DEADLINE_MICROS" ]; do
        if curl -fsS --noproxy '*' --max-time 2 "$HEALTH_URL" > /dev/null 2>&1; then
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
        poll_sleep
        now_micros
    done
    return 1
}

# After the first healthy answer, checks every POLL_INTERVAL_SECONDS for STABILITY_SECONDS that the bot stays up:
# the same process, no restarts, still answering. Returns 1 with HEALTH_PROBLEM set when it doesn't.
wait_for_stability() {
    local main_pid restarts
    main_pid="$("$SYSTEMCTL_BIN" show -p MainPID --value "$SERVICE_NAME")"
    restarts="$("$SYSTEMCTL_BIN" show -p NRestarts --value "$SERVICE_NAME")"
    # Checked every interval, not just at the end, so an outage that comes and goes inside the
    # window still counts.
    set_deadline "$STABILITY_SECONDS"
    while [ "$NOW_MICROS" -lt "$DEADLINE_MICROS" ]; do
        poll_sleep
        if [ "$("$SYSTEMCTL_BIN" show -p MainPID --value "$SERVICE_NAME")" != "$main_pid" ] \
            || [ "$("$SYSTEMCTL_BIN" show -p NRestarts --value "$SERVICE_NAME")" != "$restarts" ] \
            || ! curl -fsS --noproxy '*' --max-time 2 "$HEALTH_URL" > /dev/null 2>&1; then
            HEALTH_PROBLEM="it came up but crashed, restarted or stopped answering within ${STABILITY_SECONDS}s"
            return 1
        fi
        now_micros
    done
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

record_unapplied_migrations

# A dump from just before the restart is the way back if the new build's migrations go wrong, so it
# is required when this deploy applies migrations (or might). Otherwise a failed backup only warns.
echo "==> Backing up the database..."
if BACKUP_OUTPUT="$(bash scripts/backup-db.sh pre-deploy)"; then
    BACKUP_FILE="$(printf '%s\n' "$BACKUP_OUTPUT" | tail -n 1)"
    echo "    Saved $BACKUP_FILE"
elif [ -n "$NEW_MIGRATIONS" ] || [ "$MIGRATION_STATE_UNKNOWN" -eq 1 ]; then
    FAILURE_REASON="couldn't back up the database, and this deploy applies migrations (${NEW_MIGRATIONS:-unknown which}); not restarting without a backup"
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

trap - ERR INT TERM  # The new build is up and stayed up: nothing left to roll back.
rm -rf dist.old node_modules.old
echo "==> $SERVICE_NAME is up."
echo "==> Deploy complete."
