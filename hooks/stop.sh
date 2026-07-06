#!/bin/bash
# Runs on Stop (async). Extracts memories from new transcript content.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/load-env.sh"
ENGRAM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INPUT=$(cat)

# Anti-loop check is handled in on-stop.ts (input.stop_hook_active)
cd "$ENGRAM_DIR" && "$HOME/.bun/bin/bun" run src/hooks/on-stop.ts <<< "$INPUT" 2>/dev/null

exit 0
