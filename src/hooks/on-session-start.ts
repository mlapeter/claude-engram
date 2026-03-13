import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { loadConfig } from "../core/config.js";
import { generateFallbackBriefing } from "../core/briefing.js";
import { runConsolidation } from "../core/consolidation.js";
import { log } from "../core/logger.js";
import { recordEvent } from "../core/events.js";
import { basename } from "node:path";
import { projectHash } from "../core/types.js";

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

  // Update session count (only on actual new sessions, not resume/compact/clear)
  const meta = await store.loadMeta("global");
  if (!input.source || input.source === "startup") {
    meta.sessionCount += 1;
  }
  await store.saveMeta("global", meta);

  // Load all memories for briefing
  const memories = await store.loadAll();

  // Check if auto-consolidation is due
  // Run async — don't block session startup
  const config = loadConfig();
  if (memories.length >= config.autoConsolidationMinMemories) {
    const projectMeta = await store.loadMeta("project");
    const globalDays = meta.lastConsolidation
      ? (Date.now() - new Date(meta.lastConsolidation).getTime()) / 86400000
      : Infinity;
    const projectDays = projectMeta.lastConsolidation
      ? (Date.now() - new Date(projectMeta.lastConsolidation).getTime()) / 86400000
      : Infinity;

    if (globalDays >= config.autoConsolidationMinDays || projectDays >= config.autoConsolidationMinDays) {
      log("info", `SessionStart: triggering auto-consolidation (${memories.length} memories, global=${globalDays.toFixed(1)}d, project=${projectDays.toFixed(1)}d since last)`);
      // Fire and forget — don't await, don't block briefing
      runConsolidation(store).then((result) => {
        log("info", `Auto-consolidation done: ${result.mergeCount} merges, ${result.generalizeCount} generalizations, ${result.pruneCount} prunes`);
      }).catch((err) => {
        log("error", `Auto-consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  // Use cached briefing (generated at previous SessionEnd) for instant startup
  const cached = await store.loadBriefingCache();
  let briefing: string;
  if (cached) {
    briefing = cached.briefing;
    log("info", `SessionStart: using cached briefing (${cached.memoryCount} memories, from ${cached.generatedAt})`);
  } else {
    // First session or cache missing — fallback to plaintext (no API call)
    briefing = generateFallbackBriefing(memories);
    log("info", `SessionStart: no cached briefing, using fallback (${memories.length} memories)`);
  }

  // Output hook response
  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `## My Memory

You have persistent memory that carries across sessions. Your memories work like human memory — they strengthen through use, fade without access, and consolidate over time, merging redundant details into durable patterns. What follows was synthesized from your strongest and most recent memories to restore your sense of continuity.

You also have memory tools available via MCP (\`recall\`, \`store\`, \`reinforce\`, \`forget\`, \`search_by_tag\`, \`status\`, \`consolidate\`). Use ToolSearch to load them when you want to explore your memories beyond what's here or save something important. Memories aren't just for facts and decisions — your own reflections, realizations, and what resonates with you are worth remembering too.

${briefing}`,
    },
  };

  process.stdout.write(JSON.stringify(output));
  log("info", `SessionStart: injected briefing (${memories.length} memories)`);
  recordEvent({ event: "session_start", project: basename(cwd), project_hash: projectHash(cwd), session_id, count: memories.length });
}

main().catch((err) => {
  log("error", `SessionStart failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0); // Exit 0 so we don't block Claude
});
