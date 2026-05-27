#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
npm install

if ! command -v qlty &>/dev/null; then
  QLTY_VERSION=$(curl -fsSL -I "https://github.com/qltysh/qlty/releases/latest" | grep -i location | grep -oP 'v[\d.]+' | head -1)
  curl -fsSL "https://github.com/qltysh/qlty/releases/download/${QLTY_VERSION}/qlty-x86_64-unknown-linux-gnu.tar.xz" -o /tmp/qlty.tar.xz
  tar -xJf /tmp/qlty.tar.xz -C /tmp
  mv /tmp/qlty-x86_64-unknown-linux-gnu/qlty /root/.local/bin/qlty
  chmod +x /root/.local/bin/qlty
  rm -rf /tmp/qlty.tar.xz /tmp/qlty-x86_64-unknown-linux-gnu
fi
