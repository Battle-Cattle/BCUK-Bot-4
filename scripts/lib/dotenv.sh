# Helpers shared by deploy.sh and the backup scripts. Sourced, not run: callers set ENV_FILE first.

# Prints a setting from $ENV_FILE the way dotenv reads it: an optional `export ` prefix and spaces
# around `=` are allowed, as is dotenv's `NAME: value` form (a colon straight after the name, then
# whitespace); last entry wins; a value in double, single or back quotes is taken up to
# its closing quote (so a `#` inside it stays, and so does an escaped quote); an unquoted one ends at
# the first `#` and loses surrounding spaces. Prints nothing for no entry (grep finding nothing must
# not trip pipefail) or a blank one.
env_setting() {
    local value prefix="^[[:space:]]*(export[[:space:]]+)?$1([[:space:]]*=|:[[:space:]])"
    value="$( { grep -E "$prefix" "$ENV_FILE" 2>/dev/null || true; } | tail -n 1 | sed -E "s/$prefix//")"
    value="${value#"${value%%[![:space:]]*}"}"
    # A value in double, single or back quotes runs to the first matching quote not escaped with a
    # backslash, and keeps the escape, as dotenv does (`"p\"ss"` is `p\"ss`). One with no closing
    # quote is read as unquoted, quote and all.
    local double_quoted='^"((\\"|[^"])*)"' single_quoted="^'((\\\\'|[^'])*)'" back_quoted='^`((\\`|[^`])*)`'
    if [[ $value =~ $double_quoted || $value =~ $single_quoted || $value =~ $back_quoted ]]; then
        value="${BASH_REMATCH[1]}"
    else
        value="${value%%#*}"; value="${value%"${value##*[![:space:]]}"}"
    fi
    printf '%s' "$value"
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
# Says nothing when the file is missing or its mode can't be read (GNU stat; these scripts are
# Linux-only).
warn_if_env_readable_by_others() {
    local mode
    mode="$(stat -c %a "$ENV_FILE" 2>/dev/null)" || return 0
    [[ "$mode" =~ ^[0-7]+$ ]] || return 0
    if (( (8#$mode & 8#044) != 0 )); then
        echo "WARNING: $ENV_FILE is readable by other users on this host (mode $mode). It holds the" >&2
        echo "         database password and the bot's credentials. Make it private with:" >&2
        echo "             chmod 600 $ENV_FILE" >&2
    fi
    return 0
}
