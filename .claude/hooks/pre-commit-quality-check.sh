#!/bin/bash
set -uo pipefail

INPUT=$(cat)
CMD=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('tool_input',d).get('command',''))" "$INPUT" 2>/dev/null || true)

case "$CMD" in
  *git\ commit*) ;;
  *) exit 0 ;;
esac

if ! command -v qlty &>/dev/null; then
  exit 0
fi

STAGED=$(git diff --cached --name-only 2>/dev/null || true)
if [ -z "$STAGED" ]; then
  exit 0
fi

QLTY_OUTPUT=$(qlty check --no-progress $STAGED 2>&1)
QLTY_EXIT=$?

if [ "$QLTY_EXIT" -ne 0 ]; then
  python3 -c "
import json, sys
output = sys.argv[1]
print(json.dumps({
  'decision': 'block',
  'reason': 'qlty found issues in staged files — fix them before committing:\n' + output
}))
" "$QLTY_OUTPUT"
  exit 0
fi

exit 0
