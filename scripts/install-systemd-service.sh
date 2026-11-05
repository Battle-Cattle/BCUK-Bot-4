#!/usr/bin/env bash
# One-time setup: installs the bot as a systemd service and lets this user restart it without a
# password, which is all deploy.sh needs. Run it as the user the bot should run as (not root),
# from anywhere in the repo checkout; it asks for sudo where it needs it.
#
# Usage: bash scripts/install-systemd-service.sh
set -euo pipefail

SERVICE_NAME="bcuk-bot"
# The physical path (no symlinks), as the unit binds it into the service's view of the filesystem.
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
RUN_USER="$(id -un)"

if [ "$RUN_USER" = "root" ]; then
    echo "ERROR: run this as the user the bot should run as, not root." >&2
    exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    echo "ERROR: node is not on PATH. Install Node first (see README Requirements)." >&2
    exit 1
fi
NODE_MIN="$(sed -n 's/.*"node": ">=\([0-9.]*\)".*/\1/p' "$REPO_DIR/package.json")"
# The unit runs this exact binary, so it must meet `engines` itself (not just whatever npm uses).
if ! "$NODE_BIN" -e '
    const min = process.argv[1].split(".").map(Number);
    const cur = process.versions.node.split(".").map(Number);
    const i = min.findIndex((part, n) => cur[n] !== part);
    process.exit(i === -1 || cur[i] > min[i] ? 0 : 1);
' "$NODE_MIN"; then
    echo "ERROR: $NODE_BIN is Node $("$NODE_BIN" -v); the bot needs Node $NODE_MIN or later." >&2
    exit 1
fi

SYSTEMCTL_BIN="$(command -v systemctl || true)"
if [ -z "$SYSTEMCTL_BIN" ]; then
    echo "ERROR: systemctl not found; this host doesn't run systemd." >&2
    exit 1
fi

# Prints a setting from .env the way dotenv reads it: an optional `export ` prefix and spaces
# around `=` are allowed; last entry wins; a value in double, single or back quotes is taken up to
# its closing quote (so a `#` inside it stays, and so does an escaped quote); an unquoted one ends at
# the first `#` and loses surrounding spaces. Prints nothing for no entry (grep finding nothing must
# not trip pipefail) or a blank one.
env_setting() {
    local value
    value="$( { grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$REPO_DIR/.env" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2-)"
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

# Prints the absolute path of an upload folder setting, falling back to config.ts's default. A
# relative path is relative to the checkout, which is the unit's WorkingDirectory.
folder_path() {
    local value
    # Trimmed, and blank counts as unset, exactly as config.ts reads these settings.
    value="$(trim "$(env_setting "$1")")"
    value="${value:-$2}"
    case "$value" in
        /*) ;;
        *) value="$REPO_DIR/$value" ;;
    esac
    realpath -m "$value"
}

# Fails unless a path can be written into the unit (inside double quotes, with no % specifiers).
check_unit_path() {
    if [[ "$1" == *'"'* || "$1" == *'\'* || "$1" == *%* ]]; then
        echo "ERROR: $1 contains a quote, backslash or %, which the unit can't express." >&2
        exit 1
    fi
}

# The unit hides every home directory (ProtectHome=tmpfs) and binds back, read-only, the checkout
# and the Node install the service runs. For Node that is its install prefix (the folder above bin/),
# under both the path the unit names and the real path it resolves to (nvm's links, say), when that
# lives in a home directory; one elsewhere (e.g. /usr) stays visible anyway.
READONLY_DIRS=("$REPO_DIR")
for node_path in "$NODE_BIN" "$(realpath "$NODE_BIN")"; do
    prefix="$(dirname "$(dirname "$node_path")")"
    case "$prefix" in
        /home/*|/root|/root/*)
            [[ " ${READONLY_DIRS[*]} " == *" $prefix "* ]] || READONLY_DIRS+=("$prefix") ;;
    esac
done
READONLY_PATHS=""
for dir in "${READONLY_DIRS[@]}"; do
    check_unit_path "$dir"
    READONLY_PATHS+="${READONLY_PATHS:+ }\"${dir}\""
done

# The unit's filesystem is read-only apart from these (BindPaths): logs/ and the upload folders.
# Created now, as this user, so the bot never has to create one under a read-only parent.
WRITABLE_DIRS=(
    "$REPO_DIR/logs"
    "$(folder_path OVERLAY_FOLDER ./overlay-videos)"
    "$(folder_path ALERT_ASSETS_FOLDER ./alert-assets)"
    "$(folder_path SFX_FOLDER ./sfx)"
)
WRITABLE_PATHS=""
for dir in "${WRITABLE_DIRS[@]}"; do
    check_unit_path "$dir"
    mkdir -p "$dir"
    WRITABLE_PATHS+="${WRITABLE_PATHS:+ }\"-${dir}\""
done

echo "==> Installing /etc/systemd/system/${SERVICE_NAME}.service"
echo "    user:      $RUN_USER"
echo "    directory: $REPO_DIR"
echo "    node:      $NODE_BIN (v$("$NODE_BIN" -v | tr -d v))"
echo "    read-only: ${READONLY_DIRS[*]}"
echo "    writable:  ${WRITABLE_DIRS[*]}"
UNIT_TMP="$(mktemp)"
trap 'rm -f "$UNIT_TMP" "${SUDOERS_TMP:-}"' EXIT
# Escapes a value for the replacement side of `s|...|...|`: backslash, the `|` delimiter and `&`
# (which sed reads as "the whole match") would otherwise mangle a path that contains them.
sed_escape() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }
sed -e "s|__USER__|$(sed_escape "$RUN_USER")|" \
    -e "s|__REPO_DIR__|$(sed_escape "$REPO_DIR")|" \
    -e "s|__NODE_BIN__|$(sed_escape "$NODE_BIN")|" \
    -e "s|__READONLY_PATHS__|$(sed_escape "$READONLY_PATHS")|" \
    -e "s|__WRITABLE_PATHS__|$(sed_escape "$WRITABLE_PATHS")|" \
    "$REPO_DIR/deploy/bcuk-bot.service" > "$UNIT_TMP"
sudo install -m 644 "$UNIT_TMP" "/etc/systemd/system/${SERVICE_NAME}.service"
sudo "$SYSTEMCTL_BIN" daemon-reload
sudo "$SYSTEMCTL_BIN" enable "$SERVICE_NAME"

# deploy.sh only ever runs `sudo -n <this same systemctl path> restart bcuk-bot`; allow exactly
# that, nothing more. sudo matches the rule against that absolute path.
echo "==> Allowing $RUN_USER to restart $SERVICE_NAME without a password"
SUDOERS_TMP="$(mktemp)"
echo "${RUN_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_BIN} restart ${SERVICE_NAME}" > "$SUDOERS_TMP"
sudo visudo -cf "$SUDOERS_TMP" > /dev/null
sudo install -m 440 "$SUDOERS_TMP" "/etc/sudoers.d/${SERVICE_NAME}"

cat <<MSG
==> Done. The service is enabled (it will start on boot) but not started yet.
    If the bot is still running in the old screen session, stop it there (Ctrl-C), then:
        sudo systemctl start ${SERVICE_NAME}
    Follow its logs with:  journalctl -u ${SERVICE_NAME} -f
    From now on deploy.sh restarts it through systemd and checks it came back up.
MSG
