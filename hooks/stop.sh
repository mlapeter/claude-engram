#!/bin/bash
# Runs on Stop (async). Extracts memories from new transcript content.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGRAM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INPUT=$(cat)

# Anti-loop check
if [ "$(echo "$INPUT" | jq -r '.stop_hook_active')" = "true" ]; then
  exit 0
fi

cd "$ENGRAM_DIR" && "$HOME/.bun/bin/bun" run src/hooks/on-stop.ts <<< "$INPUT" 2>/dev/null

exit 0
