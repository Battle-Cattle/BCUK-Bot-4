#!/usr/bin/env bash
# Restores a dump made by scripts/backup-db.sh. See README "Backups".
#
# Usage: bash scripts/restore-db.sh <dump.sql.gz> [database]
#   database  Where to restore (default: DB_NAME from .env, the live database). Give another name,
#             e.g. bcuk_restore_test, to test a backup without touching the live data; it is
#             created if it doesn't exist.
#
# Restoring over the live database replaces everything in it, so it refuses while the bot's
# service is running (stop it first), asks you to type the database name to confirm, and saves the
# current data with backup-db.sh (label "pre-restore") before changing anything, unless it holds
# nothing to save (no tables, views, routines or events, or it doesn't exist yet). Dumps don't
# hold Event Scheduler events (see backup-db.sh), so one in the target survives the restore. Any
# other target that already has tables (a mistyped name, say) asks for the same confirmation,
# since every table in it is dropped first; an empty or new scratch database doesn't ask.
set -euo pipefail

SERVICE_NAME="bcuk-bot"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env"

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "Usage: bash scripts/restore-db.sh <dump.sql.gz> [database]" >&2
    exit 1
fi
DUMP="$1"
[ -f "$DUMP" ] || { echo "ERROR: $DUMP doesn't exist." >&2; exit 1; }

# Asks the operator to type the target database's name, and exits without changing anything
# unless they do.
confirm_target() {
    read -r -p "Type the database name to confirm: " CONFIRM
    if [ "$CONFIRM" != "$TARGET" ]; then
        echo "Not confirmed; nothing was changed." >&2
        exit 1
    fi
}

# shellcheck source=lib/dotenv.sh
source "$REPO_DIR/scripts/lib/dotenv.sh"
load_db_settings
TARGET="${2:-$DB_NAME}"
# Used unquoted in SQL below, so only plain identifier characters are allowed.
if ! [[ "$TARGET" =~ ^[A-Za-z0-9_]+$ ]]; then
    echo "ERROR: The database name may only contain letters, digits and _ (got '$TARGET')." >&2
    exit 1
fi
command -v mysql > /dev/null || { echo "ERROR: mysql (the client) is not installed (e.g. apt install mysql-client)." >&2; exit 1; }
gzip -t "$DUMP" || { echo "ERROR: $DUMP is not a complete gzip file." >&2; exit 1; }

if [ "$TARGET" = "$DB_NAME" ]; then
    # Only a definite "not running" lets the restore go ahead: an error asking systemd counts as
    # "can't tell", which refuses too. A host without systemd at all has no service to check.
    if command -v systemctl > /dev/null; then
        SERVICE_STATE="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
        case "$SERVICE_STATE" in
            inactive|failed) ;;
            active|activating|reloading|deactivating|refreshing)
                echo "ERROR: $SERVICE_NAME is running. Stop it first: sudo systemctl stop $SERVICE_NAME" >&2
                exit 1 ;;
            *)
                echo "ERROR: Couldn't tell whether $SERVICE_NAME is running (systemctl said '${SERVICE_STATE:-nothing}')." >&2
                echo "       Stop it (sudo systemctl stop $SERVICE_NAME) and check: systemctl is-active $SERVICE_NAME" >&2
                exit 1 ;;
        esac
    fi
    echo "This replaces everything in the live database '$TARGET' with the contents of:"
    echo "    $DUMP"
    confirm_target
fi

CREDENTIALS="$(write_mysql_credentials)"
RESTORE_SOURCE="$DUMP"
PRIVATE_COPY=""
trap 'rm -f "$CREDENTIALS" ${PRIVATE_COPY:+"$PRIVATE_COPY"}' EXIT

# Prints how many objects (tables, views, routines, events) the target holds; 0 when it doesn't
# exist, since information_schema answers without the database. Events count although dumps leave
# them out, so a database holding only an event is still saved first. Exits if the query fails, as
# that says nothing about whether there's data to save.
count_target_objects() {
    local count
    if ! count="$(mysql --defaults-extra-file="$CREDENTIALS" -N -B -e \
        "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$TARGET') + (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = '$TARGET') + (SELECT COUNT(*) FROM information_schema.events WHERE event_schema = '$TARGET')" < /dev/null)" \
        || ! [[ "$count" =~ ^[0-9]+$ ]]; then
        echo "ERROR: Couldn't check what '$TARGET' holds; nothing was changed." >&2
        exit 1
    fi
    printf '%s' "$count"
}

# Assigned on its own line so a failed check stops the script (set -e) rather than reading as "not 0".
LIVE_OBJECTS=""
if [ "$TARGET" = "$DB_NAME" ]; then LIVE_OBJECTS="$(count_target_objects)"; fi
if [ "$LIVE_OBJECTS" = 0 ]; then
    # A rebuilt server has no database yet, and mysqldump would fail on it, blocking the restore
    # just when it's needed; with nothing in it there's nothing to save.
    echo "==> '$TARGET' is empty or doesn't exist yet, so there's nothing to save first."
elif [ "$TARGET" = "$DB_NAME" ]; then
    # Tables are dropped before the import, and an import can still fail (a dump that is valid
    # gzip but not valid SQL), so save what's there first; a failed backup stops here, unchanged.
    # backup-db.sh prunes the oldest dumps, which could include $DUMP itself, so the import reads
    # a private copy taken beforehand.
    PRIVATE_COPY="$(umask 077 && mktemp)"
    cp "$DUMP" "$PRIVATE_COPY"
    RESTORE_SOURCE="$PRIVATE_COPY"
    echo "==> Saving the current contents of '$TARGET' first..."
    if ! PRE_RESTORE_OUTPUT="$(bash "$REPO_DIR/scripts/backup-db.sh" pre-restore)"; then
        echo "ERROR: Couldn't back up '$TARGET' before restoring; nothing was changed." >&2
        exit 1
    fi
    echo "==> Saved the current data to $(printf '%s\n' "$PRE_RESTORE_OUTPUT" | tail -n 1)"
    echo "    (restore that file the same way to undo this restore)."
fi

# The query-only calls read nothing from stdin, which stays free for the confirmation prompt.
mysql --defaults-extra-file="$CREDENTIALS" -e "CREATE DATABASE IF NOT EXISTS \`$TARGET\`" < /dev/null
# The dump only drops and recreates the tables it contains, so a table created after the backup (by a
# later migration, say) would otherwise survive with newer data and leave the result unlike the dump.
# Drop every table and view first; foreign-key checks are off so the order doesn't matter. A
# backtick inside a name is doubled, as MySQL's quoting needs.
DROPS="$(mysql --defaults-extra-file="$CREDENTIALS" -N -B "$TARGET" -e \
    "SELECT CONCAT(IF(table_type = 'VIEW', 'DROP VIEW IF EXISTS \`', 'DROP TABLE IF EXISTS \`'), REPLACE(table_name, '\`', '\`\`'), '\`;') FROM information_schema.tables WHERE table_schema = DATABASE()" < /dev/null)"
if [ -n "$DROPS" ]; then
    # The live database was confirmed above. Any other target is normally an empty scratch
    # database, so existing tables mean a reused or mistyped name: confirm before dropping them.
    if [ "$TARGET" != "$DB_NAME" ]; then
        echo "'$TARGET' already has tables; restoring drops all of them first."
        confirm_target
    fi
    echo "==> Clearing the existing tables in '$TARGET'..."
    printf 'SET FOREIGN_KEY_CHECKS=0;\n%s\n' "$DROPS" | mysql --defaults-extra-file="$CREDENTIALS" "$TARGET"
fi
echo "==> Restoring into '$TARGET'..."
gzip -dc "$RESTORE_SOURCE" | mysql --defaults-extra-file="$CREDENTIALS" "$TARGET"
echo "==> Restored $DUMP into '$TARGET'."
