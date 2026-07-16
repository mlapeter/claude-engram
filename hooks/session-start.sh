#!/bin/bash
# Runs on SessionStart. Injects briefing as additionalContext.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/load-env.sh"
ENGRAM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Read hook input from stdin
INPUT=$(cat)

# Run the session-start logic (this ALSO runs the active-day/sleep/wake-flush
# duties — those must happen regardless of A/B; only the briefing OUTPUT is gated).
RESULT=$(cd "$ENGRAM_DIR" && "$HOME/.bun/bin/bun" run src/hooks/on-session-start.ts <<< "$INPUT" 2>/dev/null)

# A/B alternation guard (fail-open): a sibling memory system (bansai) alternates
# which one INJECTS on a given day. On a bansai-day, engram MUTES its briefing so
# the session is never briefed by both. Extraction and every other duty in
# on-session-start.ts already ran above — this suppresses ONLY the echoed briefing.
# Any error → AB_MUTE stays empty → behave exactly as today. POSIX-safe; the
# day-parity math runs in bun (portable), not in `date`.
AB_MUTE=""
if [ -f "$HOME/.memory-ab/assignment.json" ]; then
  AB_MUTE=$("$HOME/.bun/bin/bun" -e '
    try {
      const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
      const a = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".memory-ab", "assignment.json"), "utf8"));
      let sys = "both";
      if (a.override === "bansai" || a.override === "engram") sys = a.override;
      else if (a.mode === "alternate-day") {
        const di = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim()); return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null; };
        const now = new Date();
        const today = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
        const t = di(today), anchor = di(a.anchor);
        if (t !== null && anchor !== null) sys = ((((t - anchor) % 2) + 2) % 2) === 0 ? "bansai" : "engram";
      }
      process.stdout.write(sys === "bansai" ? "mute" : "");
    } catch (e) { process.stdout.write(""); }
  ' 2>/dev/null) || AB_MUTE=""
fi

if [ -n "$RESULT" ] && [ "$AB_MUTE" != "mute" ]; then
  echo "$RESULT"
fi

exit 0
