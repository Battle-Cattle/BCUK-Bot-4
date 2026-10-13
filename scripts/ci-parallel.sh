#!/usr/bin/env bash
# Runs one npm script in the foreground (its output streams live) while the others run in the
# background with their output captured, then prints each background script's output in a
# collapsed GitHub Actions log group. Exits 1 if any of them failed, naming every failure.
#
# Usage: scripts/ci-parallel.sh <foreground-script> [background-script...]
# e.g.   scripts/ci-parallel.sh test:coverage build lint check:circular test:toolchain
set -uo pipefail

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 <foreground-script> [background-script...]" >&2
    exit 2
fi

FOREGROUND="$1"
shift
BACKGROUND=("$@")

LOG_DIR=$(mktemp -d)
trap 'rm -rf "$LOG_DIR"' EXIT

PIDS=()
for i in "${!BACKGROUND[@]}"; do
    # Index-based log names: script names like `check:circular` aren't valid Windows filenames.
    npm run "${BACKGROUND[$i]}" > "$LOG_DIR/$i.log" 2>&1 &
    PIDS[$i]=$!
done

FAILED=()
FOREGROUND_STATUS=0
npm run "$FOREGROUND" || FOREGROUND_STATUS=$?

for i in "${!BACKGROUND[@]}"; do
    STATUS=0
    wait "${PIDS[$i]}" || STATUS=$?
    echo "::group::npm run ${BACKGROUND[$i]} (exit $STATUS)"
    cat "$LOG_DIR/$i.log"
    echo "::endgroup::"
    if [ "$STATUS" -ne 0 ]; then
        echo "::error::npm run ${BACKGROUND[$i]} failed (exit $STATUS)"
        FAILED+=("${BACKGROUND[$i]}")
    fi
done

if [ "$FOREGROUND_STATUS" -ne 0 ]; then
    echo "::error::npm run $FOREGROUND failed (exit $FOREGROUND_STATUS)"
    FAILED+=("$FOREGROUND")
fi

if [ "${#FAILED[@]}" -ne 0 ]; then
    echo "Failed: ${FAILED[*]}"
    exit 1
fi
