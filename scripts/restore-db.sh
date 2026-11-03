#!/usr/bin/env bash
# Restores a dump made by scripts/backup-db.sh. See README "Backups".
#
# Usage: bash scripts/restore-db.sh <dump.sql.gz> [database]
#   database  Where to restore (default: DB_NAME from .env, the live database). Give another name,
#             e.g. bcuk_restore_test, to test a backup without touching the live data; it is
#             created if it doesn't exist.
#
# Restoring over the live database replaces everything in it, so it refuses while the bot's
# service is running (stop it first) and asks you to type the database name to confirm.
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
    if command -v systemctl > /dev/null && systemctl is-active --quiet "$SERVICE_NAME"; then
        echo "ERROR: $SERVICE_NAME is running. Stop it first: sudo systemctl stop $SERVICE_NAME" >&2
        exit 1
    fi
    echo "This replaces everything in the live database '$TARGET' with the contents of:"
    echo "    $DUMP"
    read -r -p "Type the database name to confirm: " CONFIRM
    if [ "$CONFIRM" != "$TARGET" ]; then
        echo "Not confirmed; nothing was changed." >&2
        exit 1
    fi
fi

CREDENTIALS="$(write_mysql_credentials)"
trap 'rm -f "$CREDENTIALS"' EXIT

mysql --defaults-extra-file="$CREDENTIALS" -e "CREATE DATABASE IF NOT EXISTS \`$TARGET\`"
echo "==> Restoring into '$TARGET'..."
gzip -dc "$DUMP" | mysql --defaults-extra-file="$CREDENTIALS" "$TARGET"
echo "==> Restored $DUMP into '$TARGET'."
