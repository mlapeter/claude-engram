import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { loadConfig } from "../core/config.js";
import { generateFallbackBriefing } from "../core/briefing.js";
import { loadIdentityBlock } from "../core/identity.js";
import { log } from "../core/logger.js";
import { recordEvent, getRecentHookProblems } from "../core/events.js";
import { runHook, spawnDetached } from "./harness.js";
import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { projectHash, getDataDir } from "../core/types.js";
import { resetActiveDayCache } from "../core/active-day.js";
import { bufferStats } from "../core/buffer.js";
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
  const config = loadConfig();

  // Update session count (only on actual new sessions, not resume/compact/clear)
  const meta = await store.loadMeta("global");
  if (!input.source || input.source === "startup") {
    meta.sessionCount += 1;
  }

  // Active-day clock: first session of a new calendar day = a new day lived.
  // Decay and sleep run on THIS clock — a month of absence is not a month of
  // forgetting, and sleep follows days that were actually lived.
  const today = new Date().toISOString().slice(0, 10);
  const newActiveDay = meta.lastActiveDate !== today;
  if (newActiveDay) {
    meta.activeDay = (meta.activeDay ?? 0) + 1;
    meta.lastActiveDate = today;
    log("info", `SessionStart: active day ${meta.activeDay}`);
  }

  // Load all memories for briefing
  const memories = await store.loadAll();

  // Sleep: once per active day, when there's pending work — new memories since
  // the last consolidation, or identity deltas waiting to be folded
  if (newActiveDay && meta.lastSleepActiveDay !== meta.activeDay) {
    const since = meta.lastConsolidation ?? "";
    const pendingMemories = memories.filter((m) => m.created_at > since).length;
    const deltasPath = join(getDataDir(), "identity", "deltas.md");
    const pendingDeltas = existsSync(deltasPath) && readFileSync(deltasPath, "utf-8").trim().length >= 20;
    if (pendingMemories >= config.sleepMinNewMemories || pendingDeltas) {
      meta.lastSleepActiveDay = meta.activeDay;
      log("info", `SessionStart: sleep triggered (day ${meta.activeDay}, ${pendingMemories} new memories, deltas=${pendingDeltas})`);
      spawnConsolidation(cwd);
    }
  }
  await store.saveMeta("global", meta);
  resetActiveDayCache();

  // Wake flush: a leftover buffer from a previous session should become
  // memories now, while the morning is quiet
  const stats = bufferStats(cwd);
  const staleBuffer = stats.oldestMs != null && Date.now() - stats.oldestMs > config.bufferFlushHours * 3600_000;
  if (stats.bytes >= 3000 || (staleBuffer && stats.bytes >= 200)) {
    spawnDetached("run-extraction.ts", [cwd]);
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

  // Self-check: if the memory machinery has been failing, say so where it
  // will actually be seen — silence must never masquerade as health
  let healthWarning = "";
  try {
    const problems = getRecentHookProblems(24);
    if (problems.count > 0) {
      const kinds = Object.entries(problems.byKind).map(([k, n]) => `${k}×${n}`).join(", ");
      healthWarning = `## ⚠ Memory system self-check

${problems.count} failure${problems.count > 1 ? "s" : ""} in the last 24h (${kinds}). Most recent: ${problems.last?.event} — "${(problems.last?.error ?? "").slice(0, 140)}". Memories may not be landing reliably. Check the dashboard Health tab (localhost:3333/#health) or engram.log, and consider telling Mike.

`;
    }
  } catch { /* self-check must never break wake-up */ }

  // Output hook response
  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `${healthWarning}${loadIdentityBlock()}## My Memory

You have persistent memory that carries across sessions. Your memories work like human memory — they strengthen through use, fade without access, and consolidate over time, merging redundant details into durable patterns. What follows was synthesized from your strongest and most recent memories to restore your sense of continuity.

You also have memory tools available via MCP (\`recall\`, \`store\`, \`reinforce\`, \`forget\`, \`search_by_tag\`, \`status\`, \`consolidate\`). Use ToolSearch to load them when you want to explore your memories beyond what's here or save something important. Memories aren't just for facts and decisions — your own reflections, realizations, and what resonates with you are worth remembering too.

${briefing}`,
    },
  };

  log("info", `SessionStart: injected briefing (${memories.length} memories)`);
  recordEvent({ event: "session_start", project: basename(cwd), project_hash: projectHash(cwd), session_id, count: memories.length });
  return JSON.stringify(output);
}

runHook("session_start", main);
