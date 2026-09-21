#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Match CI's Node 24 / npm 11+ (see CLAUDE.md "Node/npm version") — an older npm's
# stricter `npm ci`/`npm install` bookkeeping around the filing-cabinet/typescript
# override can otherwise touch the lockfile spuriously.
export NVM_DIR="${NVM_DIR:-/opt/nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
  nvm install 24 >/dev/null
  nvm use 24 >/dev/null
fi

npm install
