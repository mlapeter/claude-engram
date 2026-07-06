import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { loadConfig } from "../core/config.js";
import { generateFallbackBriefing } from "../core/briefing.js";
import { loadIdentityBlock } from "../core/identity.js";
import { log } from "../core/logger.js";
import { recordEvent } from "../core/events.js";
import { basename } from "node:path";
import { projectHash } from "../core/types.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Spawn consolidation as a DETACHED child so it survives this hook process.
 * Running it in-process kept the hook alive until Claude Code's hook timeout
 * killed it — the observed session-start hang, and the reason consolidations
 * died mid-run leaving stale locks.
 */
function spawnConsolidation(cwd: string): void {
  try {
    const runner = fileURLToPath(new URL("./run-consolidation.ts", import.meta.url));
    const child = spawn(process.execPath, [runner, cwd], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    log("info", `SessionStart: spawned detached consolidation (pid=${child.pid})`);
  } catch (err) {
    log("error", `SessionStart: failed to spawn consolidation: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(input: HookInput): Promise<string> {
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

  // Check if auto-consolidation is due — run detached, never block session startup
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
      spawnConsolidation(cwd);
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
      additionalContext: `${loadIdentityBlock()}## My Memory

You have persistent memory that carries across sessions. Your memories work like human memory — they strengthen through use, fade without access, and consolidate over time, merging redundant details into durable patterns. What follows was synthesized from your strongest and most recent memories to restore your sense of continuity.

You also have memory tools available via MCP (\`recall\`, \`store\`, \`reinforce\`, \`forget\`, \`search_by_tag\`, \`status\`, \`consolidate\`). Use ToolSearch to load them when you want to explore your memories beyond what's here or save something important. Memories aren't just for facts and decisions — your own reflections, realizations, and what resonates with you are worth remembering too.

${briefing}`,
    },
  };

  log("info", `SessionStart: injected briefing (${memories.length} memories)`);
  recordEvent({ event: "session_start", project: basename(cwd), project_hash: projectHash(cwd), session_id, count: memories.length });
  return JSON.stringify(output);
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}

/** Entry: records a hook_session_start health event and exits explicitly. */
async function run(): Promise<void> {
  const t0 = Date.now();
  let input: HookInput | null = null;
  try {
    if (process.env.ENGRAM_DISABLE) {
      log("info", "SessionStart: disabled via ENGRAM_DISABLE");
      process.exit(0);
    }
    input = JSON.parse(await readStdin()) as HookInput;
    const output = await main(input);
    recordEvent({ event: "hook_session_start", project: basename(input.cwd), project_hash: projectHash(input.cwd), session_id: input.session_id, duration_ms: Date.now() - t0 });
    process.stdout.write(output, () => process.exit(0));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `SessionStart failed: ${msg}`);
    if (input) {
      recordEvent({ event: "hook_session_start", project: basename(input.cwd), project_hash: projectHash(input.cwd), session_id: input.session_id, duration_ms: Date.now() - t0, error: msg });
    }
    process.exit(0); // Exit 0 so we don't block Claude
  }
}

run();
