# Helpers shared by deploy.sh and the backup scripts. Sourced, not run: callers set ENV_FILE first.

# The script env_setting runs: scripts/envSetting.js, next to this lib/ folder.
DOTENV_SETTING_JS="${DOTENV_SETTING_JS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/envSetting.js}"

# Prints the node binary to read .env with: $NODE_BIN if set, else the node on PATH, else the one
# the bot's systemd service runs (cron's PATH usually lacks a node installed with nvm, and that is
# the node the bot reads .env with anyway). Prints nothing if none is found.
dotenv_node() {
    if [ -n "${NODE_BIN:-}" ]; then printf '%s' "$NODE_BIN"; return 0; fi
    command -v node 2>/dev/null && return 0
    systemctl show -p ExecStart --value bcuk-bot 2>/dev/null | sed -n 's/.*path=\([^ ;]*\).*/\1/p' || true
}

# Prints a setting from $ENV_FILE exactly as the bot reads it: parsed by the checkout's own dotenv
# package (scripts/envSetting.js), so quoting, `export`, `NAME: value`, multi-line values and
# escapes all read the same. Prints nothing for no entry or a blank one, or a missing file. Fails
# (with a message) if node or dotenv can't be found: never reads that as "unset". Sourcing this
# file has already checked both (see the end of the file), since a failure inside a nested
# `$(trim "$(env_setting X)")`, or anywhere `set -e` is ignored, would otherwise be lost.
env_setting() {
    local node
    node="$(dotenv_node)"
    if [ -z "$node" ]; then
        echo "ERROR: node not found to read $ENV_FILE. Put it on PATH or set NODE_BIN to its path." >&2
        return 1
    fi
    "$node" "$DOTENV_SETTING_JS" "$ENV_FILE" "$1"
}

# Checks env_setting can read .env: node is found and loads the checkout's dotenv (from
# node_modules, or node_modules.old while deploy.sh has it moved aside). Prints why not and returns
# 1 otherwise.
check_dotenv_reader() {
    local node
    node="$(dotenv_node)"
    if [ -z "$node" ]; then
        echo "ERROR: node not found to read $ENV_FILE. Put it on PATH or set NODE_BIN to its path." >&2
        return 1
    fi
    "$node" "$DOTENV_SETTING_JS" --check
}

# Strips leading and trailing whitespace from $1, as config.ts's trim() does.
trim() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    printf '%s' "${value%"${value##*[![:space:]]}"}"
}

# Loads DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME from $ENV_FILE, with config.ts's
# defaults for host and port. Exits if the user or database name is missing, or if one of them is
# also exported in this shell with a different value: the bot's dotenv doesn't override exported
# variables, so a bot started from this shell would use another database than these scripts.
load_db_settings() {
    check_exported_db_settings
    DB_HOST="$(env_setting DB_HOST)"; DB_HOST="${DB_HOST:-localhost}"
    DB_PORT="$(env_setting DB_PORT)"; DB_PORT="${DB_PORT:-3306}"
    DB_USER="$(env_setting DB_USER)"
    DB_PASSWORD="$(env_setting DB_PASSWORD)"
    DB_NAME="$(env_setting DB_NAME)"
    if [ -z "$DB_USER" ] || [ -z "$DB_NAME" ]; then
        echo "ERROR: DB_USER and DB_NAME must be set in $ENV_FILE." >&2
        exit 1
    fi
}

# Exits if a DB_* setting is exported in this shell with a value other than $ENV_FILE's (after
# config.ts's defaults for host and port). Only exported ones count: those are what a bot started
# from this shell would see.
check_exported_db_settings() {
    local name exported from_file
    for name in DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME; do
        exported="$(printenv "$name" 2>/dev/null)" || continue
        from_file="$(env_setting "$name")"
        case "$name" in
            DB_HOST) from_file="${from_file:-localhost}" ;;
            DB_PORT) from_file="${from_file:-3306}" ;;
        esac
        if [ "$exported" != "$from_file" ]; then
            echo "ERROR: $name is exported in this shell with a different value from $ENV_FILE's." >&2
            echo "       A bot started from this shell would use the exported one, so it's unclear which" >&2
            echo "       database is meant. Make sure the running bot uses $ENV_FILE's settings, then" >&2
            echo "       unset $name here (or make the two match) and try again." >&2
            exit 1
        fi
    done
}

# Writes a private MySQL option file holding the connection settings and prints its path. The
# password goes here rather than on the command line, where any user on the host could read it
# from the process list. Values are quoted, with backslashes and quotes escaped, so any password
# survives. The caller deletes the file.
write_mysql_credentials() {
    local file
    file="$(umask 077 && mktemp)"
    {
        echo "[client]"
        echo "host=\"$(mysql_option_escape "$DB_HOST")\""
        echo "port=$DB_PORT"
        echo "user=\"$(mysql_option_escape "$DB_USER")\""
        echo "password=\"$(mysql_option_escape "$DB_PASSWORD")\""
    } > "$file"
    printf '%s' "$file"
}

# Escapes a value for a double-quoted MySQL option-file entry.
mysql_option_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Warns, without failing, when $ENV_FILE can be read by its group or by other users: it holds the
# database password, EVENTSUB_TOKEN_SECRET and the Discord/Twitch credentials, and only the bot's
# own user needs to read it. Prints the chmod that fixes it, but never changes the mode itself.
# A symlinked .env is checked by the file it points to (stat -L), the one the bot actually reads
# and the one chmod changes. Says nothing when the file is missing or its mode can't be read (GNU
# stat; these scripts are Linux-only). The path in the printed command is shell-quoted, so it can
# be copied as is even when it contains spaces.
warn_if_env_readable_by_others() {
    local mode
    mode="$(stat -L -c %a "$ENV_FILE" 2>/dev/null)" || return 0
    [[ "$mode" =~ ^[0-7]+$ ]] || return 0
    if (( (8#$mode & 8#044) != 0 )); then
        echo "WARNING: $ENV_FILE is readable by other users on this host (mode $mode). It holds the" >&2
        echo "         database password and the bot's credentials. Make it private with:" >&2
        printf '             chmod 600 %q\n' "$ENV_FILE" >&2
    fi
    return 0
}

# Sourcing this file checks env_setting works and exits the script (or the subshell it's sourced
# in) if not, so nothing carries on reading every setting as unset. That has to be decided here:
# bash ignores `set -e` inside a function called from an `if`, so a failed env_setting there would
# go unnoticed. deploy.sh sets DOTENV_RETURN_ON_FAILURE=1 to get a failed `source` instead, and
# rolls back.
if ! check_dotenv_reader; then
    if [ "${DOTENV_RETURN_ON_FAILURE:-0}" = 1 ]; then return 1; fi
    exit 1
fi
