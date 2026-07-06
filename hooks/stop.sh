#!/bin/bash
# Runs on Stop (async). Extracts memories from new transcript content.
set -e

# Preserve ENGRAM_DISABLE across env loading
_ENGRAM_DISABLE="$ENGRAM_DISABLE"

# Load API keys: prefer the dedicated env file (fast, reliable under bash);
# fall back to sourcing the shell profile for older installs.
if [ -f "$HOME/.claude-engram/env" ]; then
  set -a
  . "$HOME/.claude-engram/env" 2>/dev/null || true
  set +a
else
  [ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null || true
fi

export ENGRAM_DISABLE="${_ENGRAM_DISABLE}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGRAM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INPUT=$(cat)

# Anti-loop check is handled in on-stop.ts (input.stop_hook_active)
cd "$ENGRAM_DIR" && "$HOME/.bun/bin/bun" run src/hooks/on-stop.ts <<< "$INPUT" 2>/dev/null

exit 0
