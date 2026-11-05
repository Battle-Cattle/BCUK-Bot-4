# Helpers shared by deploy.sh and the backup scripts. Sourced, not run: callers set ENV_FILE first.

# Prints a setting from $ENV_FILE the way dotenv reads it: an optional `export ` prefix and spaces
# around `=` are allowed; last entry wins; a quoted value is taken up to its closing quote (so a
# `#` inside it stays, and so does an escaped quote); an unquoted one ends at the first `#` and loses
# surrounding spaces. Prints nothing for no entry (grep finding nothing must not trip
# pipefail) or a blank one.
env_setting() {
    local value
    value="$( { grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$ENV_FILE" 2>/dev/null || true; } \
        | tail -n 1 | cut -d= -f2-)"
    value="${value#"${value%%[![:space:]]*}"}"
    # A quoted value runs to the first quote not escaped with a backslash, and keeps the escape, as
    # dotenv does (`"p\"ss"` is `p\"ss`). One with no closing quote is read as unquoted, quote and all.
    local double_quoted='^"((\\"|[^"])*)"' single_quoted="^'((\\\\'|[^'])*)'"
    if [[ $value =~ $double_quoted || $value =~ $single_quoted ]]; then
        value="${BASH_REMATCH[1]}"
    else
        value="${value%%#*}"; value="${value%"${value##*[![:space:]]}"}"
    fi
    printf '%s' "$value"
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
