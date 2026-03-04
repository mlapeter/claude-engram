#!/bin/bash
# Runs on SessionEnd. Final memory extraction safety net.
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

cd "$ENGRAM_DIR" && "$HOME/.bun/bin/bun" run src/hooks/on-session-end.ts <<< "$INPUT" 2>/dev/null

exit 0
