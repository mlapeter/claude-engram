#!/bin/bash
# Failure drills — every scenario must degrade gracefully with a logged reason.
#
# Runs the real hooks under bun against a throwaway data dir, with API keys
# stripped from the environment (so no drill ever makes a paid API call).
# Scenarios (PLAN-NEXT.md Phase A.5):
#   1. no ANTHROPIC_API_KEY  — extraction fails; episode ask must still fire
#   2. no keys at session-end — briefing generation fails with a logged reason;
#                               fallback briefing is cached and cursor still resets
#   3. empty data dir         — session-start emits a valid JSON briefing fallback
#   4. huge transcript (~10MB)— stop truncates, stays bounded in time, still asks for episode
# (VOYAGE_API_KEY is absent in every drill — embeddings must silently fall back throughout.)
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

BUN="${BUN:-$HOME/.bun/bin/bun}"
SESSION="dri11abc-0000-4000-8000-000000000000"
PASS=0
FAIL=0

ok()  { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

check_eq() { # <description> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got: $2)"; fi
}

check_contains() { # <description> <haystack> <needle>
  if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else bad "$1"; fi
}

check_log() { # <description> <data-dir> <needle>
  if grep -q "$3" "$2/engram.log" 2>/dev/null; then ok "$1"; else bad "$1"; fi
}

make_transcript() { # <path> <lines>
  python3 - "$1" "$2" <<'EOF'
import json, sys
path, n = sys.argv[1], int(sys.argv[2])
with open(path, "w") as f:
    for i in range(n):
        role = "user" if i % 2 == 0 else "assistant"
        f.write(json.dumps({"type": role, "message": {"role": role,
            "content": f"turn {i}: " + "substantive discussion of the work at hand " * 12}}) + "\n")
EOF
}

run_hook() { # <hook-file> <data-dir> <input-json>  → stdout of the hook; exit code preserved
  # cwd is the throwaway data dir and the keys are explicitly EMPTY (not unset):
  # bun auto-loads .env from the cwd, and set-but-empty vars take precedence —
  # both together guarantee the drill can never reach a real API key.
  printf '%s' "$3" | (cd "$2" && env -u ENGRAM_DISABLE \
    ANTHROPIC_API_KEY="" VOYAGE_API_KEY="" \
    ENGRAM_DATA_DIR="$2" "$BUN" run "$ROOT/src/hooks/$1" 2>/dev/null)
}

hook_input() { # <transcript-path>
  printf '{"session_id":"%s","transcript_path":"%s","cwd":"%s","stop_hook_active":false}' \
    "$SESSION" "$1" "$(pwd)"
}

echo "=== Drill 1: Stop with no ANTHROPIC_API_KEY (extraction dies, episode ask survives) ==="
DIR=$(mktemp -d "${TMPDIR:-/tmp}/engram-drill-1-XXXXXX")
make_transcript "$DIR/transcript.jsonl" 12
OUT=$(run_hook on-stop.ts "$DIR" "$(hook_input "$DIR/transcript.jsonl")")
CODE=$?
check_eq       "hook exits 0"                "$CODE" 0
check_contains "episode block still emitted" "$OUT" '"decision":"block"'
check_log      "extraction failure logged"   "$DIR" "Memory extraction failed"
check_log      "episode ask logged"          "$DIR" "requested episode self-dump"
rm -rf "$DIR"

echo "=== Drill 2: SessionEnd with no keys (briefing degrades, cursor still resets) ==="
DIR=$(mktemp -d "${TMPDIR:-/tmp}/engram-drill-2-XXXXXX")
make_transcript "$DIR/transcript.jsonl" 4
# Seed one memory — an empty store returns the welcome message without an API call
mkdir -p "$DIR/global"
python3 - "$DIR/global/memories.json" <<'EOF'
import json, sys, datetime
mem = {"id": "m_1_drill", "content": "drill seed memory", "scope": "global",
       "memory_type": "episodic",
       "salience": {"novelty": 0.5, "relevance": 0.5, "emotional": 0.5, "predictive": 0.5},
       "tags": ["technical"], "access_count": 0, "last_accessed": None,
       "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
       "consolidated": False, "generalized": False,
       "source_session": "drill", "updated_from": None}
json.dump([mem], open(sys.argv[1], "w"))
EOF
run_hook on-session-end.ts "$DIR" "$(hook_input "$DIR/transcript.jsonl")" >/dev/null
CODE=$?
check_eq  "hook exits 0"                     "$CODE" 0
check_log "briefing failure logged"          "$DIR" "Briefing generation failed"
check_log "fallback briefing still cached"   "$DIR" "cached briefing"
check_log "cursor still reset"               "$DIR" "cursor reset"
rm -rf "$DIR"

echo "=== Drill 3: SessionStart with empty data dir (valid fallback briefing) ==="
DIR=$(mktemp -d "${TMPDIR:-/tmp}/engram-drill-3-XXXXXX")
OUT=$(run_hook on-session-start.ts "$DIR" "$(hook_input /nonexistent-transcript.jsonl)")
CODE=$?
check_eq "hook exits 0" "$CODE" 0
if printf '%s' "$OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["hookSpecificOutput"]["additionalContext"]' 2>/dev/null; then
  ok "output is valid hook JSON with context"
else
  bad "output is valid hook JSON with context"
fi
check_log "fallback briefing logged" "$DIR" "using fallback"
rm -rf "$DIR"

echo "=== Drill 4: Stop with a huge transcript (~10MB) stays bounded ==="
DIR=$(mktemp -d "${TMPDIR:-/tmp}/engram-drill-4-XXXXXX")
make_transcript "$DIR/transcript.jsonl" 20000
START=$SECONDS
OUT=$(run_hook on-stop.ts "$DIR" "$(hook_input "$DIR/transcript.jsonl")")
CODE=$?
ELAPSED=$((SECONDS - START))
check_eq       "hook exits 0"                          "$CODE" 0
if [ "$ELAPSED" -lt 60 ]; then ok "bounded time (<60s, took ${ELAPSED}s)"; else bad "bounded time (<60s, took ${ELAPSED}s)"; fi
check_contains "episode block still emitted"           "$OUT" '"decision":"block"'
rm -rf "$DIR"

echo
echo "Drills: $PASS passed, $FAIL failed"
test "$FAIL" -eq 0
