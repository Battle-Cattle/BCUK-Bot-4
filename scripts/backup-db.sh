#!/usr/bin/env bash
# Dumps the bot's database to a gzipped SQL file and prunes old dumps. deploy.sh runs it before
# every restart; it is also meant for a nightly cron job (see README "Backups").
#
# Usage: bash scripts/backup-db.sh [label]
#   label  Optional word added to the file name (letters, digits, - and _), e.g. "pre-deploy".
#
# Reads DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME from the checkout's .env, plus:
#   BACKUP_DIR   Where dumps go (default: ~/bcuk-bot-backups). Created private (mode 700).
#   BACKUP_KEEP  How many dumps to keep (default: 14). The oldest beyond that are deleted.
# Prints the new dump's path as its last line of output.
#
# A dump holds every stored OAuth token, encrypted with EVENTSUB_TOKEN_SECRET. Treat dumps as
# secrets, and keep that key backed up somewhere else: without it, restored tokens can't be read.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env"
LABEL="${1:-}"

if [ -n "$LABEL" ] && ! [[ "$LABEL" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "ERROR: The label may only contain letters, digits, - and _ (got '$LABEL')." >&2
    exit 1
fi

# shellcheck source=lib/dotenv.sh
source "$REPO_DIR/scripts/lib/dotenv.sh"
load_db_settings
BACKUP_DIR="$(env_setting BACKUP_DIR)"; BACKUP_DIR="${BACKUP_DIR:-$HOME/bcuk-bot-backups}"
BACKUP_KEEP="$(env_setting BACKUP_KEEP)"; BACKUP_KEEP="${BACKUP_KEEP:-14}"

if ! [[ "$BACKUP_KEEP" =~ ^[0-9]+$ ]] || [ "$BACKUP_KEEP" -lt 1 ]; then
    echo "ERROR: BACKUP_KEEP must be a whole number of at least 1 (got '$BACKUP_KEEP')." >&2
    exit 1
fi
command -v mysqldump > /dev/null || { echo "ERROR: mysqldump is not installed (e.g. apt install mysql-client)." >&2; exit 1; }
command -v gzip > /dev/null || { echo "ERROR: gzip is not installed." >&2; exit 1; }

# Everything this script creates is readable by this user only.
umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

CREDENTIALS="$(write_mysql_credentials)"
PARTIAL=""
trap 'rm -f "$CREDENTIALS" ${PARTIAL:+"$PARTIAL"}' EXIT

# The process ID keeps two runs in the same second (a manual backup during a deploy, say) apart.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
FILE="$BACKUP_DIR/${DB_NAME}-${STAMP}${LABEL:+-$LABEL}.sql.gz"
# Written under a temporary name and renamed once complete, so a failed or interrupted dump never
# looks like a usable backup (and is never counted when pruning).
PARTIAL="$FILE.partial"

# --single-transaction: a consistent snapshot of InnoDB tables without locking the live bot out.
# --no-tablespaces: MySQL 8 otherwise needs the PROCESS privilege, which the bot's user lacks.
# No --events: the bot uses no Event Scheduler events, and dumping them needs the EVENT privilege,
# which the bot's user may not have (a failed dump fails the deploy). See README "Backups".
mysqldump --defaults-extra-file="$CREDENTIALS" --single-transaction --routines --triggers \
    --no-tablespaces "$DB_NAME" | gzip > "$PARTIAL"
mv "$PARTIAL" "$FILE"
PARTIAL=""

# Keep the newest BACKUP_KEEP dumps of this database. Names sort by their UTC timestamp, so a
# plain sort is oldest first. The pattern pins the timestamp, so another database whose name
# starts with this one's (bcuk vs bcuk-test) never has its dumps pruned here.
mapfile -t DUMPS < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}-[0-9]*T[0-9]*Z*.sql.gz" -printf '%f\n' | sort)
# The dump just made is never pruned, even where the sort puts it among the oldest (two dumps in the
# same second compare their process IDs as text).
EXCESS=$(( ${#DUMPS[@]} - BACKUP_KEEP ))
REMOVED=0
for dump in "${DUMPS[@]}"; do
    [ "$REMOVED" -lt "$EXCESS" ] || break
    [ "$dump" = "${FILE##*/}" ] && continue
    rm -f "$BACKUP_DIR/$dump"
    REMOVED=$((REMOVED + 1))
done

echo "$FILE"
