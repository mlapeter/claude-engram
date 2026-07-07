# Shared env loader for engram hooks — source this, don't execute it.
#
# Loads API keys for the bun hook processes. Order:
#   1. ~/.claude-engram/env (dedicated file, fast and reliable under bash)
#   2. ~/.zshrc fallback whenever ANTHROPIC_API_KEY is still missing — an env
#      file that exists but lacks the key must NOT silently strip auth from
#      the hooks (bun also auto-loads a repo .env from cwd, but a fresh clone
#      has none).
# ENGRAM_DISABLE is preserved across profile sourcing.

_ENGRAM_DISABLE="$ENGRAM_DISABLE"

if [ -f "$HOME/.claude-engram/env" ]; then
  set -a
  . "$HOME/.claude-engram/env" 2>/dev/null || true
  set +a
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  [ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null || true
fi

export ENGRAM_DISABLE="${_ENGRAM_DISABLE}"
