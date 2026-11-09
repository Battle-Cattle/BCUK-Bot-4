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

# env_setting and trim: .env read the way dotenv (and so the bot) reads it, shared with deploy.sh
# and the backup scripts.
ENV_FILE="$REPO_DIR/.env"
# shellcheck source=lib/dotenv.sh
source "$REPO_DIR/scripts/lib/dotenv.sh"

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

# Fails unless a path can be written into the unit as is: inside double quotes, with no % specifiers,
# and no colon (which BindPaths= reads as the split between source, destination and options).
check_unit_path() {
    if [[ "$1" == *'"'* || "$1" == *'\'* || "$1" == *%* || "$1" == *:* ]]; then
        echo "ERROR: $1 contains a quote, backslash, % or colon, which the unit can't express." >&2
        exit 1
    fi
}

# The unit hides every home directory (ProtectHome=tmpfs) and binds back, read-only, the checkout
# and the node binary the service runs: the path the unit names and the file it resolves to (nvm's
# links, say), each when it lives in a home directory (one elsewhere, e.g. /usr, stays visible
# anyway). Only the binary, never the folder it's in: node needs nothing else from its install at
# runtime (npm runs from the deploy shell, not the service), and its folder can be shared with
# unrelated files (~/bin, ~/.local) that the sandbox is there to hide.
READONLY_BINDS=("$REPO_DIR")
for node_path in "$NODE_BIN" "$(realpath "$NODE_BIN")"; do
    case "$node_path" in
        /home/*|/root/*)
            [[ " ${READONLY_BINDS[*]} " == *" $node_path "* ]] || READONLY_BINDS+=("$node_path") ;;
    esac
done
READONLY_PATHS=""
for dir in "${READONLY_BINDS[@]}"; do
    check_unit_path "$dir"
    READONLY_PATHS+="${READONLY_PATHS:+ }\"${dir}\""
done

# The unit's filesystem is read-only apart from these (BindPaths): logs/, the upload folders and the
# folder chunked uploads are assembled in (overlay videos assemble inside OVERLAY_FOLDER instead).
# Created now, as this user, so the bot never has to create one under a read-only parent.
WRITABLE_DIRS=(
    "$REPO_DIR/logs"
    "$(folder_path OVERLAY_FOLDER ./overlay-videos)"
    "$(folder_path ALERT_ASSETS_FOLDER ./alert-assets)"
    "$(folder_path SFX_FOLDER ./sfx)"
    "$(folder_path UPLOAD_INCOMING_FOLDER ./upload-incoming)"
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
echo "    read-only: ${READONLY_BINDS[*]}"
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
