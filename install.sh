#!/bin/bash
set -e

# Determine install location from script's own path
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGRAM_DIR="$SCRIPT_DIR"
DATA_DIR="$HOME/.claude-engram"
SETTINGS_FILE="$HOME/.claude/settings.json"

echo "=== claude-engram installer ==="
echo "Install dir: $ENGRAM_DIR"
echo "Data dir:    $DATA_DIR"
echo ""

# 1. Create data directory structure
echo "[1/6] Creating data directory structure..."
mkdir -p "$DATA_DIR/global"
mkdir -p "$DATA_DIR/projects"
mkdir -p "$DATA_DIR/backups"

# Initialize empty JSON files if they don't exist
for f in "$DATA_DIR/global/memories.json"; do
  [ -f "$f" ] || echo '[]' > "$f"
done
for f in "$DATA_DIR/global/meta.json"; do
  [ -f "$f" ] || echo '{"lastConsolidation":null,"created":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","sessionCount":0}' > "$f"
done

echo "  Done."

# 2. Install npm dependencies
echo "[2/6] Installing dependencies..."
cd "$ENGRAM_DIR"
if command -v "$HOME/.bun/bin/bun" &>/dev/null; then
  "$HOME/.bun/bin/bun" install
elif command -v bun &>/dev/null; then
  bun install
else
  echo "  ERROR: bun not found. Install bun: https://bun.sh"
  exit 1
fi
echo "  Done."

# 3. Make hook scripts executable
echo "[3/6] Making hook scripts executable..."
chmod +x "$ENGRAM_DIR/hooks/"*.sh
echo "  Done."

# 4. Merge hooks into ~/.claude/settings.json
echo "[4/6] Registering hooks in $SETTINGS_FILE..."
mkdir -p "$(dirname "$SETTINGS_FILE")"

# Build the hooks config
HOOKS_JSON=$(cat <<HOOKEOF
{
  "SessionStart": [
    {
      "matcher": "startup",
      "hooks": [
        {
          "type": "command",
          "command": "$ENGRAM_DIR/hooks/session-start.sh",
          "timeout": 30
        }
      ]
    }
  ],
  "Stop": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "$ENGRAM_DIR/hooks/stop.sh",
          "timeout": 30
        }
      ]
    }
  ],
  "SessionEnd": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "$ENGRAM_DIR/hooks/session-end.sh",
          "timeout": 60
        }
      ]
    }
  ]
}
HOOKEOF
)

if [ -f "$SETTINGS_FILE" ]; then
  # Merge hooks into existing settings (don't overwrite other hooks)
  EXISTING=$(cat "$SETTINGS_FILE")
  MERGED=$(echo "$EXISTING" | jq --argjson hooks "$HOOKS_JSON" '
    .hooks = (.hooks // {}) |
    .hooks.SessionStart = ((.hooks.SessionStart // []) + $hooks.SessionStart | unique_by(.hooks[0].command)) |
    .hooks.Stop = ((.hooks.Stop // []) + $hooks.Stop | unique_by(.hooks[0].command)) |
    .hooks.SessionEnd = ((.hooks.SessionEnd // []) + $hooks.SessionEnd | unique_by(.hooks[0].command))
  ')
  echo "$MERGED" > "$SETTINGS_FILE"
else
  echo "{\"hooks\": $HOOKS_JSON}" | jq '.' > "$SETTINGS_FILE"
fi
echo "  Done."

# 5. MCP server registration (print instructions for Phase 2)
echo "[5/6] MCP server..."
echo "  MCP server will be registered in Phase 2."
echo "  When ready, run:"
echo "    claude mcp add --transport stdio --scope user engram -- bun run $ENGRAM_DIR/src/mcp/server.ts"

# 6. Check ANTHROPIC_API_KEY
echo "[6/6] Checking ANTHROPIC_API_KEY..."
if [ -n "$ANTHROPIC_API_KEY" ]; then
  echo "  ANTHROPIC_API_KEY is set."
else
  echo "  WARNING: ANTHROPIC_API_KEY is not set."
  echo "  Memory extraction and briefing generation require an API key."
  echo "  Set it with: export ANTHROPIC_API_KEY=your-key-here"
fi

echo ""
echo "=== Installation complete ==="
echo ""
echo "Data directory: $DATA_DIR"
echo "Hooks registered in: $SETTINGS_FILE"
echo ""
echo "Start a new Claude Code session to test:"
echo "  claude --debug"
echo ""
