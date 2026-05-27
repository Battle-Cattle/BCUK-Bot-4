#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
npm install

if ! command -v qlty &>/dev/null; then
  curl -fsSL https://qlty.sh/install.sh | bash
fi
