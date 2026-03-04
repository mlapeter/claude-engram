#!/bin/bash
# Runs before context compaction. Saves memories and injects mini-briefing.
set -e

# Preserve ENGRAM_DISABLE across profile sourcing
_ENGRAM_DISABLE="$ENGRAM_DISABLE"

# Source shell profile to get ANTHROPIC_API_KEY
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null || true

export ENGRAM_DISABLE="${_ENGRAM_DISABLE}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGRAM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load engram .env for API keys (VOYAGE_API_KEY, etc.)
[ -f "$ENGRAM_DIR/.env" ] && set -a && source "$ENGRAM_DIR/.env" && set +a

INPUT=$(cat)

RESULT=$(cd "$ENGRAM_DIR" && "$HOME/.bun/bin/bun" run src/hooks/on-pre-compact.ts <<< "$INPUT" 2>/dev/null)

if [ -n "$RESULT" ]; then
  echo "$RESULT"
fi

exit 0
