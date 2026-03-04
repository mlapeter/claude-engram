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

# Load .env if present (for API keys)
if [ -f "$ENGRAM_DIR/.env" ]; then
  set -a
  source "$ENGRAM_DIR/.env"
  set +a
  echo "Loaded .env file."
fi

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
  ],
  "PreCompact": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "$ENGRAM_DIR/hooks/pre-compact.sh",
          "timeout": 30
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
    .hooks.SessionEnd = ((.hooks.SessionEnd // []) + $hooks.SessionEnd | unique_by(.hooks[0].command)) |
    .hooks.PreCompact = ((.hooks.PreCompact // []) + $hooks.PreCompact | unique_by(.hooks[0].command))
  ')
  echo "$MERGED" > "$SETTINGS_FILE"
else
  echo "{\"hooks\": $HOOKS_JSON}" | jq '.' > "$SETTINGS_FILE"
fi
echo "  Done."

# 5. Register MCP server at user scope
echo "[5/6] Registering MCP server..."

# Determine bun path
if command -v "$HOME/.bun/bin/bun" &>/dev/null; then
  BUN_PATH="$HOME/.bun/bin/bun"
elif command -v bun &>/dev/null; then
  BUN_PATH="$(which bun)"
else
  echo "  ERROR: bun not found."
  exit 1
fi

# Remove existing registration if present, then re-add
# Pass API keys so MCP server can call APIs for consolidation + embeddings
if command -v claude &>/dev/null; then
  claude mcp remove --scope user engram 2>/dev/null || true

  # Build env flags
  MCP_ENV_FLAGS=""
  if [ -n "$ANTHROPIC_API_KEY" ]; then
    MCP_ENV_FLAGS="$MCP_ENV_FLAGS -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
  fi
  if [ -n "$VOYAGE_API_KEY" ]; then
    MCP_ENV_FLAGS="$MCP_ENV_FLAGS -e VOYAGE_API_KEY=$VOYAGE_API_KEY"
  fi

  if [ -n "$MCP_ENV_FLAGS" ]; then
    eval claude mcp add --transport stdio --scope user engram $MCP_ENV_FLAGS -- "$BUN_PATH" run "$ENGRAM_DIR/src/mcp/server.ts"
  else
    claude mcp add --transport stdio --scope user engram -- "$BUN_PATH" run "$ENGRAM_DIR/src/mcp/server.ts"
    echo "  NOTE: No API keys found. Set them in .env and re-run install.sh."
  fi
  echo "  MCP server registered as 'engram' (user scope)."
else
  echo "  WARNING: 'claude' CLI not found. Register manually:"
  echo "    claude mcp add --transport stdio --scope user engram -e ANTHROPIC_API_KEY=\$ANTHROPIC_API_KEY -- $BUN_PATH run $ENGRAM_DIR/src/mcp/server.ts"
fi

# 6. Check API keys
echo "[6/6] Checking API keys..."
if [ -n "$ANTHROPIC_API_KEY" ]; then
  echo "  ANTHROPIC_API_KEY: set"
else
  echo "  ANTHROPIC_API_KEY: NOT SET (required for memory extraction + briefing)"
  echo "    Add to .env: ANTHROPIC_API_KEY=your-key-here"
fi
if [ -n "$VOYAGE_API_KEY" ]; then
  echo "  VOYAGE_API_KEY:   set (vector embeddings enabled)"
else
  echo "  VOYAGE_API_KEY:   not set (optional — enables semantic search)"
  echo "    Get a free key: https://dash.voyageai.com/"
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
