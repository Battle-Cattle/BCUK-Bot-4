#!/usr/bin/env bash
# One-time setup: installs the bot as a systemd service and lets this user restart it without a
# password, which is all deploy.sh needs. Run it as the user the bot should run as (not root),
# from anywhere in the repo checkout; it asks for sudo where it needs it.
#
# Usage: bash scripts/install-systemd-service.sh
set -euo pipefail

SERVICE_NAME="bcuk-bot"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
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

echo "==> Installing /etc/systemd/system/${SERVICE_NAME}.service"
echo "    user:      $RUN_USER"
echo "    directory: $REPO_DIR"
echo "    node:      $NODE_BIN (v$("$NODE_BIN" -v | tr -d v))"
UNIT_TMP="$(mktemp)"
trap 'rm -f "$UNIT_TMP" "${SUDOERS_TMP:-}"' EXIT
# Escapes a value for the replacement side of `s|...|...|`: backslash, the `|` delimiter and `&`
# (which sed reads as "the whole match") would otherwise mangle a path that contains them.
sed_escape() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }
sed -e "s|__USER__|$(sed_escape "$RUN_USER")|" \
    -e "s|__REPO_DIR__|$(sed_escape "$REPO_DIR")|" \
    -e "s|__NODE_BIN__|$(sed_escape "$NODE_BIN")|" \
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
