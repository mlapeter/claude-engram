#!/bin/bash
# Runs on SessionEnd. Final memory extraction safety net.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGRAM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INPUT=$(cat)

cd "$ENGRAM_DIR" && "$HOME/.bun/bin/bun" run src/hooks/on-session-end.ts <<< "$INPUT" 2>/dev/null

exit 0
