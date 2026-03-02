#!/bin/bash
# Runs on SessionStart. Injects briefing as additionalContext.
set -e

# Preserve ENGRAM_DISABLE across profile sourcing
_ENGRAM_DISABLE="$ENGRAM_DISABLE"

# Source shell profile to get ANTHROPIC_API_KEY
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null || true

export ENGRAM_DISABLE="${_ENGRAM_DISABLE}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGRAM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Read hook input from stdin
INPUT=$(cat)

# Run the session-start logic
RESULT=$(cd "$ENGRAM_DIR" && "$HOME/.bun/bin/bun" run src/hooks/on-session-start.ts <<< "$INPUT" 2>/dev/null)

if [ -n "$RESULT" ]; then
  echo "$RESULT"
fi

exit 0
