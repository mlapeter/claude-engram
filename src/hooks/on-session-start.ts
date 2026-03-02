import { basename } from "node:path";
import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { loadConfig } from "../core/config.js";
import { generateBriefing } from "../core/briefing.js";
import { runConsolidation } from "../core/consolidation.js";
import { log } from "../core/logger.js";

async function main() {
  if (process.env.ENGRAM_DISABLE) {
    log("info", "SessionStart: disabled via ENGRAM_DISABLE");
    return;
  }

  let rawInput = "";
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  const input: HookInput = JSON.parse(rawInput);
  const { session_id, cwd } = input;

  log("info", `SessionStart: session=${session_id} cwd=${cwd}`);

  const store = createStore(cwd);

  // Update session count
  const meta = await store.loadMeta("global");
  meta.sessionCount += 1;
  await store.saveMeta("global", meta);

  // Load all memories for briefing
  const memories = await store.loadAll();

  // Check if auto-consolidation is due
  // Run async — don't block session startup
  const config = loadConfig();
  if (memories.length >= config.autoConsolidationMinMemories) {
    const daysSinceLast = meta.lastConsolidation
      ? (Date.now() - new Date(meta.lastConsolidation).getTime()) / 86400000
      : Infinity;

    if (daysSinceLast >= config.autoConsolidationMinDays) {
      log("info", `SessionStart: triggering auto-consolidation (${memories.length} memories, ${daysSinceLast.toFixed(1)} days since last)`);
      // Fire and forget — don't await, don't block briefing
      runConsolidation(store).then((result) => {
        log("info", `Auto-consolidation done: ${result.mergeCount} merges, ${result.generalizeCount} generalizations, ${result.pruneCount} prunes`);
      }).catch((err) => {
        log("error", `Auto-consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  // Generate briefing with context-dependent retrieval
  const projectName = basename(cwd);
  const briefing = await generateBriefing(memories, { cwd, projectName });

  // Output hook response
  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `## My Memory\n\n${briefing}`,
    },
  };

  process.stdout.write(JSON.stringify(output));
  log("info", `SessionStart: injected briefing (${memories.length} memories)`);
}

main().catch((err) => {
  log("error", `SessionStart failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0); // Exit 0 so we don't block Claude
});
